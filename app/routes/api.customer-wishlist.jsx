import { jwtVerify } from "jose";
import { unauthenticated } from "../shopify.server";

const WISHLIST_NAMESPACE = "custom";
const WISHLIST_KEY = "wishlist";

function jsonResponse(data, init = {}) {
  return Response.json(data, {
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      ...init.headers,
    },
    ...init,
  });
}

async function customerFromSessionToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;

  if (!token) return null;

  const { payload } = await jwtVerify(
    token,
    new TextEncoder().encode(process.env.SHOPIFY_API_SECRET || ""),
    { audience: process.env.SHOPIFY_API_KEY, algorithms: ["HS256"] },
  );
  const customerId = typeof payload.sub === "string" ? payload.sub : null;
  const destination = typeof payload.dest === "string" ? payload.dest : null;

  if (!customerId?.startsWith("gid://shopify/Customer/") || !destination) {
    return null;
  }

  return { customerId, shopDomain: new URL(destination).hostname };
}

function graphqlError(result) {
  return result.errors?.map(({ message }) => message).join("; ") || null;
}

async function readWishlist(admin, customerId) {
  const response = await admin.graphql(
    `#graphql
      query CustomerWishlist($id: ID!) {
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
  const error = graphqlError(result);
  if (error) throw new Error(error);
  const handles = result.data?.customer?.metafield?.jsonValue;
  return Array.isArray(handles) ? handles : [];
}

async function writeWishlist(admin, customerId, handles) {
  const response = await admin.graphql(
    `#graphql
      mutation SaveCustomerWishlist($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
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
  const error = graphqlError(result) || result.data?.metafieldsSet?.userErrors?.map(({ message }) => message).join("; ");
  if (error) throw new Error(error);
}

export async function loader({ request }) {
  try {
    const identity = await customerFromSessionToken(request);
    if (!identity) return jsonResponse({ error: "A signed-in customer is required." }, { status: 401 });
    const { admin } = await unauthenticated.admin(identity.shopDomain);
    return jsonResponse({ handles: await readWishlist(admin, identity.customerId) });
  } catch (error) {
    console.error("Customer wishlist load failed:", error);
    return jsonResponse({ error: "Unable to load wishlist." }, { status: 401 });
  }
}

export async function action({ request }) {
  if (request.method === "OPTIONS") return jsonResponse(null, { status: 204 });

  try {
    const identity = await customerFromSessionToken(request);
    if (!identity) return jsonResponse({ error: "A signed-in customer is required." }, { status: 401 });
    const body = await request.json();
    const handles = Array.isArray(body.handles)
      ? [...new Set(body.handles.filter((handle) => typeof handle === "string" && handle.length <= 255))]
      : null;
    if (!handles) return jsonResponse({ error: "handles must be an array." }, { status: 400 });
    const { admin } = await unauthenticated.admin(identity.shopDomain);
    await writeWishlist(admin, identity.customerId, handles);
    return jsonResponse({ handles });
  } catch (error) {
    console.error("Customer wishlist save failed:", error);
    return jsonResponse({ error: "Unable to save wishlist." }, { status: 422 });
  }
}