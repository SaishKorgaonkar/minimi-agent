/**
 * Where the user is, so "price of X" means prices where they shop. Taken from
 * the browser: the timezone first (it reflects where the machine is; a
 * language like "en-US" is often just a default), then the language's region.
 * USER_COUNTRY in .env overrides both.
 */
export interface UserLocation {
  /** ISO 3166-1 alpha-2, e.g. "IN". */
  code: string;
  /** English name, e.g. "India". */
  name: string;
  source: 'config' | 'timezone' | 'locale';
}

// Timezones that identify one country. Zones shared by several countries are left out.
const TZ_COUNTRY: Record<string, string> = {
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Karachi': 'PK', 'Asia/Dhaka': 'BD', 'Asia/Kathmandu': 'NP',
  'Asia/Colombo': 'LK', 'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA', 'Asia/Singapore': 'SG', 'Asia/Kuala_Lumpur': 'MY',
  'Asia/Jakarta': 'ID', 'Asia/Manila': 'PH', 'Asia/Bangkok': 'TH', 'Asia/Ho_Chi_Minh': 'VN', 'Asia/Hong_Kong': 'HK',
  'Asia/Shanghai': 'CN', 'Asia/Taipei': 'TW', 'Asia/Seoul': 'KR', 'Asia/Tokyo': 'JP', 'Asia/Jerusalem': 'IL',
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Zurich': 'CH', 'Europe/Vienna': 'AT',
  'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ', 'Europe/Lisbon': 'PT', 'Europe/Athens': 'GR', 'Europe/Istanbul': 'TR', 'Europe/Kyiv': 'UA',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US',
  'America/Anchorage': 'US', 'Pacific/Honolulu': 'US', 'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Mexico_City': 'MX',
  'America/Sao_Paulo': 'BR', 'America/Argentina/Buenos_Aires': 'AR', 'America/Bogota': 'CO', 'America/Santiago': 'CL', 'America/Lima': 'PE',
  'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE', 'Africa/Cairo': 'EG', 'Africa/Johannesburg': 'ZA',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU', 'Pacific/Auckland': 'NZ',
};

const names = new Intl.DisplayNames(['en'], { type: 'region' });

function make(code: string, source: UserLocation['source']): UserLocation | null {
  const c = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  const name = names.of(c);
  return name && name !== c ? { code: c, name, source } : null;
}

export function resolveLocation(locale?: string, tz?: string): UserLocation | null {
  if (process.env.USER_COUNTRY) return make(process.env.USER_COUNTRY, 'config');
  if (tz && TZ_COUNTRY[tz]) return make(TZ_COUNTRY[tz], 'timezone');
  if (locale) {
    try {
      const region = new Intl.Locale(locale).maximize().region;
      if (region) return make(region, 'locale');
    } catch {
      // not a valid locale tag
    }
  }
  return null;
}
