export default defineComponent({
  name: "Fetch Braze Catalog",
  description: "Fetches all items from the crm_prism_surveys Braze catalog",
  props: {
    braze: {
      type: "app",
      app: "braze",
    },
  },
  async run({ $ }) {
    const { instance_domain, region, api_key } = this.braze.$auth;
    const baseURL = `https://${instance_domain}.braze.${region}`;
    const headers = {
      "Authorization": `Bearer ${api_key}`,
      "Content-Type": "application/json",
    };

    const allItems = [];
    let cursor = null;

    do {
      const url = new URL(`${baseURL}/catalogs/crm_prism_surveys/items`);
      if (cursor) url.searchParams.set("cursor", cursor);

      const resp = await fetch(url.toString(), { headers });
      if (!resp.ok) throw new Error(`Braze API error: ${resp.status}`);

      const data = await resp.json();
      const items = data.items || [];
      allItems.push(...items);
      cursor = data.cursor || null;
    } while (cursor);

    $.export("$summary", `Fetched ${allItems.length} catalog items from crm_prism_surveys`);
    return allItems;
  },
});
