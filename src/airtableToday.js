import 'dotenv/config';

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_VIEW = process.env.AIRTABLE_VIEW || 'Published';

function requireEnv(value, name) {
  if (!value || !value.trim()) {
    throw new Error(`Missing ${name}`);
  }
  return value.trim();
}

function getConfig() {
  return {
    baseId: requireEnv(AIRTABLE_BASE_ID, 'AIRTABLE_BASE_ID'),
    tableId: requireEnv(AIRTABLE_TABLE_ID, 'AIRTABLE_TABLE_ID'),
    token: requireEnv(AIRTABLE_TOKEN, 'AIRTABLE_TOKEN'),
    view: AIRTABLE_VIEW,
  };
}

function mapRecord(record) {
  const fields = record.fields || {};
  const imageList = Array.isArray(fields.image) ? fields.image : [];
  const firstImage = imageList.length > 0 ? imageList[0] : null;

  return {
    recordId: record.id,
    slug: fields.slug ?? '',
    city: fields.city ?? '',
    type: fields.type ?? '',
    section: fields.section ?? '',
    title: fields.title ?? '',
    subtitle: fields.subtitle ?? '',
    description: fields.description ?? '',
    area: fields.area ?? '',
    priceLabel: fields.priceLabel ?? '',
    badge: fields.badge ?? '',
    searchQuery: fields.searchQuery ?? '',
    emoji: fields.emoji ?? '📍',
    tags: Array.isArray(fields.tags) ? fields.tags : [],
    isBudgetPick: Boolean(fields.isBudgetPick),
    isNightPick: Boolean(fields.isNightPick),
    isPublished: Boolean(fields.isPublished),
    sortOrder:
      typeof fields.sortOrder === 'number' ? fields.sortOrder : 9999,
    eventDate: fields.eventDate ?? '',
    imageUrl: firstImage?.url ?? null,
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
    url.searchParams.set('sort[0][field]', 'sortOrder');
    url.searchParams.set('sort[0][direction]', 'asc');

    if (offset) {
      url.searchParams.set('offset', offset);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error?.message || 'Failed to load Airtable records');
    }

    const records = Array.isArray(data.records) ? data.records : [];
    results.push(...records.map(mapRecord));

    offset = data.offset;
  } while (offset);

  return results.filter((item) => {
    if (!item.isPublished) return false;
    if (city && item.city.toLowerCase() !== city.toLowerCase()) return false;
    return true;
  });
}