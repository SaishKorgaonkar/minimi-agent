"""
Optimise a prompt with the real GEPA library (github.com/gepa-ai/gepa).

GEPA is Python; the agent is TypeScript. This adapter runs every evaluation
through scripts/optimize/rollout.ts, so GEPA scores candidates with exactly the
same data, models and scorer as `npm run optimize`. GEPA's own engine does the
search: Pareto candidate selection, reflective mutation and merge.

    uv venv data/.venv --python 3.12 && VIRTUAL_ENV=data/.venv uv pip install gepa openai
    data/.venv/bin/python scripts/optimize/gepa_bridge.py judge 120
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import gepa
from gepa.core.adapter import EvaluationBatch
from openai import OpenAI

ROOT = Path(__file__).resolve().parents[2]
TASK = sys.argv[1] if len(sys.argv) > 1 else "judge"
BUDGET = int(sys.argv[2]) if len(sys.argv) > 2 else 120


def load_env():
    env = ROOT / ".env"
    for line in env.read_text().splitlines() if env.exists() else []:
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def rollout(payload: dict):
    proc = subprocess.run(
        ["npx", "tsx", "scripts/optimize/rollout.ts"],
        input=json.dumps(payload), capture_output=True, text=True, cwd=ROOT,
        env={**os.environ, "LOG_LEVEL": "error"},
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr[-2000:])
    return json.loads(proc.stdout)


class RolloutAdapter:
    propose_new_texts = None

    def evaluate(self, batch, candidate, capture_traces=False):
        results = {r["id"]: r for r in rollout({"task": TASK, "instructions": candidate["instructions"], "ids": [ex["id"] for ex in batch]})}
        rows = [results[ex["id"]] for ex in batch]
        return EvaluationBatch(
            outputs=[r["output"] for r in rows],
            scores=[r["score"] for r in rows],
            trajectories=[{"input": ex["input"], "output": r["output"], "feedback": r["feedback"]} for ex, r in zip(batch, rows)] if capture_traces else None,
        )

    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        records = [{"Inputs": t["input"], "Generated Outputs": t["output"], "Feedback": t["feedback"]} for t in eval_batch.trajectories]
        return {name: records for name in components_to_update}


def main():
    load_env()
    client = OpenAI()
    model = os.environ.get("MODEL_ANSWER", "gpt-6.1-sol")

    def reflection_lm(prompt: str) -> str:
        # Same reflection model and effort as the TypeScript optimiser.
        r = client.responses.create(model=model, input=prompt, reasoning={"effort": "low"})
        return r.output_text

    info = rollout({"task": TASK, "list": True})
    train = [e for e in info["examples"] if e["split"] == "train"]
    val = [e for e in info["examples"] if e["split"] == "val"]
    result = gepa.optimize(
        seed_candidate={"instructions": info["seed"]},
        trainset=train, valset=val,
        adapter=RolloutAdapter(),
        reflection_lm=reflection_lm,
        reflection_minibatch_size=3,
        use_merge=True,
        max_metric_calls=BUDGET,
        run_dir=str(ROOT / f"data/optimize/gepa-{TASK}"),
        display_progress_bar=False,
        seed=0,
    )
    scores = list(result.val_aggregate_scores)
    best = result.best_candidate["instructions"]
    out = {
        "task": TASK, "method": "gepa", "budget": BUDGET, "best": best,
        "bestVal": max(scores), "seedVal": scores[0], "candidates": len(scores),
        "valScores": scores, "pool": [c["instructions"] for c in result.candidates],
    }
    (ROOT / "data/optimize").mkdir(parents=True, exist_ok=True)
    (ROOT / f"data/optimize/{TASK}-gepa.json").write_text(json.dumps(out, indent=1))
    print(f"[{TASK}] GEPA best val {max(scores):.3f} (seed {scores[0]:.3f}) · {len(scores)} candidates")


if __name__ == "__main__":
    main()
