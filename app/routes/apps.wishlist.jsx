import { authenticate } from "../shopify.server";

const WISHLIST_NAMESPACE = "custom";
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

async function customerIdFromAccountToken(request, shopDomain) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;

  if (!token) return null;

  const discoveryResponse = await fetch(
    `https://${shopDomain}/.well-known/customer-account-api`,
  );
  if (!discoveryResponse.ok) throw new Error("Customer Account API discovery failed.");

  const { graphql_api: graphqlEndpoint } = await discoveryResponse.json();
  const customerResponse = await fetch(graphqlEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: "query { customer { id } }",
    }),
  });
  const result = await customerResponse.json();
  const error = graphqlErrorResponse(result);
  const customerId = result.data?.customer?.id;

  if (error || !customerId) {
    throw new Error(error || "Customer Account API did not return a customer.");
  }

  return customerId;
}

export async function loader({ request }) {
  const { admin, session } = await authenticate.public.appProxy(request);
  const customerId = request.headers.get("Authorization")
    ? await customerIdFromAccountToken(request, session.shop)
    : customerIdFromRequest(request);

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
  const { admin, session } = await authenticate.public.appProxy(request);
  const customerId = request.headers.get("Authorization")
    ? await customerIdFromAccountToken(request, session.shop)
    : customerIdFromRequest(request);

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

  const definitionResponse = await admin.graphql(
    `#graphql
      query WishlistDefinition {
        metafieldDefinitions(first: 10, ownerType: CUSTOMER, query: "namespace:custom AND key:wishlist") {
          nodes {
            namespace
            key
            type { name }
          }
        }
      }
    `,
  );
  const definitionResult = await definitionResponse.json();
  const definitionError = graphqlErrorResponse(definitionResult);
  const definition = definitionResult.data?.metafieldDefinitions?.nodes?.find(
    (node) => node.namespace === WISHLIST_NAMESPACE && node.key === WISHLIST_KEY,
  );

  if (definitionError || !definition) {
    const error = definitionError || "Customer metafield custom.wishlist is not defined.";
    console.error("Wishlist definition lookup failed:", error);
    return jsonResponse({ error }, { status: 422 });
  }

  const metafieldType = definition.type?.name;
  if (!['json', 'list.single_line_text_field'].includes(metafieldType)) {
    const error = `custom.wishlist must be JSON or a list of single-line text, not ${metafieldType}.`;
    console.error("Wishlist definition has unsupported type:", error);
    return jsonResponse({ error }, { status: 422 });
  }

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
          type: metafieldType,
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
