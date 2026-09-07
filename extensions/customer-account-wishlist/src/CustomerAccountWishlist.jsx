import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const API_URL = "https://custom-wishlist-zufv.onrender.com/api/customer-wishlist";

export default async () => {
  render(<CustomerAccountWishlist />, document.body);
};

function CustomerAccountWishlist() {
  const [handles, setHandles] = useState(null);
  const [newHandle, setNewHandle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const token = await shopify.sessionToken.get();
        const response = await fetch(API_URL, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setHandles(result.handles);
      } catch (loadError) {
        setError(loadError.message);
      }
    }
    load();
  }, []);

  async function saveHandle() {
    const handle = newHandle.trim();
    if (!handle || handles === null) return;
    setSaving(true);
    setError(null);
    try {
      const token = await shopify.sessionToken.get();
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handles: [...new Set([...handles, handle])] }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setHandles(result.handles);
      setNewHandle("");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <s-page heading="Wishlist">
      {error && <s-banner tone="critical">{error}</s-banner>}
      <s-stack direction="inline" gap="base">
        <s-text-field
          label="Product handle"
          value={newHandle}
          onInput={(event) => setNewHandle(event.currentTarget.value)}
        />
        <s-button loading={saving} onClick={saveHandle}>Save</s-button>
      </s-stack>
      {handles && handles.length === 0 && <s-text>No saved items yet.</s-text>}
      {handles && handles.length > 0 && (
        <s-stack direction="block" gap="base">
          {handles.map((handle) => <s-text key={handle}>{handle}</s-text>)}
        </s-stack>
      )}
      {!handles && !error && <s-text>Loading wishlist...</s-text>}
    </s-page>
  );
}