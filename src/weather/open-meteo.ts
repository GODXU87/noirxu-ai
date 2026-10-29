import { ToolError } from '@/hub/errors';

// Today's weather from Open-Meteo (free, no account or key, non-commercial use). Only the
// coordinates of one fixed place are sent — no personal data. Feature 'weather' (opt-in).
// Location defaults to 林口 and can be changed with NOIRXU_AI_WEATHER_LAT / _LON / _NAME.

export interface WeatherToday {
  date: string; place: string; summary: string; code: number | null;
  temp_max: number | null; temp_min: number | null; rain_chance: number | null; rain_mm: number | null; uv_max: number | null;
  advice: string[]; source: 'Open-Meteo';
}

export interface WeatherPlace { lat: number; lon: number; name: string }
export const DEFAULT_PLACE: WeatherPlace = { lat: 25.077, lon: 121.391, name: '林口' };

export function placeFromEnv(env = process.env): WeatherPlace {
  const lat = Number(env.NOIRXU_AI_WEATHER_LAT);
  const lon = Number(env.NOIRXU_AI_WEATHER_LON);
  return Number.isFinite(lat) && Number.isFinite(lon) && env.NOIRXU_AI_WEATHER_LAT && env.NOIRXU_AI_WEATHER_LON ? { lat, lon, name: env.NOIRXU_AI_WEATHER_NAME?.trim() || '設定地點' } : DEFAULT_PLACE;
}

/** WMO weather interpretation codes (the ones Open-Meteo returns). */
export function weatherLabel(code: number | null): string {
  if (code === null) return '天氣資料不完整';
  if (code === 0) return '晴';
  if (code <= 2) return '晴時多雲';
  if (code === 3) return '陰';
  if (code === 45 || code === 48) return '有霧';
  if (code >= 51 && code <= 57) return '毛毛雨';
  if (code >= 61 && code <= 67) return code >= 65 ? '大雨' : '雨';
  if (code >= 71 && code <= 77) return '雪';
  if (code >= 80 && code <= 82) return code === 82 ? '強陣雨' : '陣雨';
  if (code >= 95) return '雷雨';
  return '多雲';
}

const first = (v: unknown) => (Array.isArray(v) && typeof v[0] === 'number' && Number.isFinite(v[0]) ? v[0] as number : null);

export function weatherFromResponse(body: unknown, place: WeatherPlace): WeatherToday {
  const daily = (body as { daily?: Record<string, unknown> } | null)?.daily;
  if (!daily || !Array.isArray(daily.time) || !daily.time.length) throw new ToolError('INVALID_OUTPUT', '天氣服務回傳格式不符，沒有使用。');
  const code = first(daily.weather_code);
  const tmax = first(daily.temperature_2m_max);
  const tmin = first(daily.temperature_2m_min);
  const pop = first(daily.precipitation_probability_max);
  const rain = first(daily.precipitation_sum);
  const uv = first(daily.uv_index_max);
  const advice: string[] = [];
  if ((pop ?? 0) >= 50 || (code !== null && code >= 51)) advice.push('出門帶傘');
  if ((tmax ?? 0) >= 32) advice.push('高溫，運動多補水、避開正午');
  else if ((tmin ?? 99) <= 15) advice.push('早晚偏涼，帶件外套');
  if ((uv ?? 0) >= 8) advice.push('紫外線強，注意防曬');
  return {
    date: String(daily.time[0]), place: place.name, summary: weatherLabel(code), code,
    temp_max: tmax, temp_min: tmin, rain_chance: pop, rain_mm: rain, uv_max: uv, advice, source: 'Open-Meteo'
  };
}

export async function fetchWeather(place: WeatherPlace, fetcher: typeof fetch = fetch): Promise<WeatherToday> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(place.lat), longitude: String(place.lon), timezone: 'Asia/Taipei', forecast_days: '1',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,uv_index_max'
  }).toString();
  let response: Response;
  try {
    response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new ToolError('UPSTREAM_UNAVAILABLE', '天氣服務暫時連不上。');
  }
  if (!response.ok) throw new ToolError('UPSTREAM_UNAVAILABLE', `天氣服務回應 HTTP ${response.status}。`);
  return weatherFromResponse(await response.json().catch(() => null), place);
}

export function weatherLine(w: WeatherToday) {
  const temp = w.temp_min !== null && w.temp_max !== null ? ` ${Math.round(w.temp_min)}–${Math.round(w.temp_max)}°C` : '';
  const rain = w.rain_chance !== null ? `，降雨機率 ${Math.round(w.rain_chance)}%` : '';
  return `${w.place}${w.summary}${temp}${rain}${w.advice.length ? `，${w.advice.join('、')}` : ''}`;
}
