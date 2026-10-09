import { LOCATIONS, googleLocations } from './dataforseo.js';

/** Validate before saving setup or starting any paid collection. Never substitute a market. */
export async function measurementLocation(project, { locations = LOCATIONS, lookup = googleLocations, requireGoogle = false } = {}) {
  const market = String(project.market || '').trim().toUpperCase();
  const city = String(project.location_name || '').trim();
  const blocked = error => ({ ok: false, code: 'MEASUREMENT_LOCATION_REQUIRED', error });
  if (!/^[A-Z]{2}$/.test(market)) return blocked('Choose a market before continuing.');
  const google = requireGoogle || (project.engines || []).some(e => e === 'ai_mode' || e === 'ai_overview');
  if (!google) return { ok: true, market, locationName: city || null };
  if (!city) {
    if (locations[market]) return { ok: true, market, locationName: locations[market] };
    return blocked(`Google collection is not configured for the whole country in ${market}. Choose a verified location in this market, or ask support to enable country-level collection. Nothing will run until the location is valid.`);
  }
  try {
    const places = await lookup(market);
    if (!places.some(place => place.name === city)) return blocked('That Google location could not be verified in the selected market. Choose a location from the list before continuing.');
  } catch {
    return blocked('The Google location could not be verified right now. Retry the location lookup before continuing. Your selected market has not been changed.');
  }
  return { ok: true, market, locationName: city };
}

export async function assertMeasurementLocation(project, options) {
  const result = await measurementLocation(project, options);
  if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
  return result;
}
