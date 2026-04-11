import 'dotenv/config';

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_VIEW = process.env.AIRTABLE_VIEW || 'Grid view';

function requireEnv(value, name) {
  if (!value || !String(value).trim()) {
    throw new Error(`Missing ${name}`);
  }
  return String(value).trim();
}

function getConfig() {
  return {
    baseId: requireEnv(AIRTABLE_BASE_ID, 'AIRTABLE_BASE_ID'),
    tableId: requireEnv(AIRTABLE_TABLE_ID, 'AIRTABLE_TABLE_ID'),
    token: requireEnv(AIRTABLE_TOKEN, 'AIRTABLE_TOKEN'),
    view: AIRTABLE_VIEW,
  };
}

function toStringValue(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function toBoolValue(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', ''].includes(normalized)) return false;

  return fallback;
}

function toIntValue(value, fallback = 9999) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }

  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toTagsValue(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
}

function mapRecord(record) {
  const fields = record.fields || {};
  const imageList = Array.isArray(fields['Image']) ? fields['Image'] : [];
  const firstImage = imageList.length > 0 ? imageList[0] : null;

  return {
    recordId: toStringValue(record.id),
    slug: toStringValue(fields['Slug']),
    city: toStringValue(fields['City']),
    type: toStringValue(fields['Type']),
    section: toStringValue(fields['Section']),
    title: toStringValue(fields['Title']),
    subtitle: toStringValue(fields['Subtitle']),
    description: toStringValue(
      fields['Full Description'] ?? fields['Short Description']
    ),
    area: toStringValue(fields['Area']),
    priceLabel: toStringValue(fields['Price Label']),
    badge: toStringValue(fields['Badge']),
    searchQuery: toStringValue(fields['Search Query']),
    emoji: toStringValue(fields['Emoji'], '📍'),
    tags: toTagsValue(fields['Tags']),
    isBudgetPick: toBoolValue(fields['Is Budget Pick']),
    isNightPick: toBoolValue(fields['Is Night Pick']),
    isPublished: toBoolValue(fields['Is Published'], true),
    sortOrder: toIntValue(fields['Sort Order'], 9999),
    eventDate: toStringValue(fields['Event Date']),
    imageUrl: firstImage?.url ?? null,
    likeCount: 0,
    commentCount: 0,
    isLiked: false,
  };
}

export async function listTodayItems({ city }) {
  const { baseId, tableId, token, view } = getConfig();

  let offset;
  const results = [];

  do {
    const url = new URL(
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableId)}`
    );

    url.searchParams.set('view', view);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('sort[0][field]', 'Sort Order');
    url.searchParams.set('sort[0][direction]', 'asc');

    if (offset) {
      url.searchParams.set('offset', offset);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Airtable error body:', data);
      throw new Error(data?.error?.message || 'Failed to load Airtable records');
    }

    const records = Array.isArray(data.records) ? data.records : [];
    results.push(...records.map(mapRecord));

    offset = data.offset;
  } while (offset);

  const normalizedCity =
    typeof city === 'string' ? city.trim().toLowerCase() : '';

  return results.filter((item) => {
    if (!item.isPublished) return false;
    if (normalizedCity && item.city.toLowerCase() !== normalizedCity) {
      return false;
    }
    return true;
  });
}
