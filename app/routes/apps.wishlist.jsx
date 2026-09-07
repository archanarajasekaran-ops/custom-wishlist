import { authenticate } from "../shopify.server";

const WISHLIST_NAMESPACE = "$app";
const WISHLIST_KEY = "wishlist";

function customerIdFromRequest(request) {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  return customerId ? `gid://shopify/Customer/${customerId}` : null;
}

function jsonResponse(data, init = {}) {
  return Response.json(data, {
    headers: { "Cache-Control": "no-store" },
    ...init,
  });
}

function graphqlErrorResponse(result) {
  const errors = result.errors || [];
  return errors.length ? errors.map(({ message }) => message).join("; ") : null;
}

export async function loader({ request }) {
  const { admin } = await authenticate.public.appProxy(request);
  const customerId = customerIdFromRequest(request);

  if (!admin || !customerId) return jsonResponse({ handles: [] });

  const response = await admin.graphql(
    `#graphql
      query Wishlist($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "${WISHLIST_NAMESPACE}", key: "${WISHLIST_KEY}") {
            jsonValue
          }
        }
      }
    `,
    { variables: { id: customerId } },
  );
  const result = await response.json();
  const graphqlError = graphqlErrorResponse(result);
  if (graphqlError) {
    console.error("Wishlist load failed:", graphqlError);
    return jsonResponse({ error: graphqlError, handles: [] }, { status: 502 });
  }
  const handles = result.data?.customer?.metafield?.jsonValue;

  return jsonResponse({ handles: Array.isArray(handles) ? handles : [] });
}

export async function action({ request }) {
  const { admin } = await authenticate.public.appProxy(request);
  const customerId = customerIdFromRequest(request);

  if (!admin || !customerId) {
    return jsonResponse({ error: "A logged-in customer is required." }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, { status: 400 });
  }

  const handles = Array.isArray(body.handles)
    ? [...new Set(body.handles.filter((handle) => typeof handle === "string" && handle.length <= 255))]
    : null;

  if (!handles) return jsonResponse({ error: "handles must be an array." }, { status: 400 });

  const response = await admin.graphql(
    `#graphql
      mutation SaveWishlist($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { namespace key jsonValue }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        metafields: [{
          ownerId: customerId,
          namespace: WISHLIST_NAMESPACE,
          key: WISHLIST_KEY,
          type: "list.single_line_text_field",
          value: JSON.stringify(handles),
        }],
      },
    },
  );
  const result = await response.json();
  const graphqlError = graphqlErrorResponse(result);
  const userErrors = result.data?.metafieldsSet?.userErrors || [];

  if (graphqlError || userErrors.length) {
    const error = graphqlError || userErrors.map(({ message }) => message).join("; ");
    console.error("Wishlist save failed:", error, {
      customerId,
      fields: userErrors.flatMap(({ field }) => field || []),
    });
    return jsonResponse({ error }, { status: 422 });
  }

  return jsonResponse({ handles });
}
