import {
  type BusinessEntityListQuery,
  type BusinessEntityPage,
  businessEntityListQuerySchema,
  businessEntityPageSchema,
} from "@battlefield/contracts";

function getApiConfiguration(): {
  baseUrl: string;
  headers: Record<string, string>;
} {
  const configuredBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (process.env.NODE_ENV === "production") {
    if (!configuredBaseUrl) {
      throw new Error("The production API endpoint is not configured.");
    }
    throw new Error("Production authentication is not configured.");
  }

  return {
    baseUrl: configuredBaseUrl ?? "http://localhost:3001",
    headers: {
      "x-tenant-id":
        process.env.NEXT_PUBLIC_DEV_TENANT_ID ??
        "10000000-0000-4000-8000-000000000001",
      "x-user-id":
        process.env.NEXT_PUBLIC_DEV_USER_ID ??
        "30000000-0000-4000-8000-000000000001",
    },
  };
}

export async function listBusinessEntities(
  input: BusinessEntityListQuery,
): Promise<BusinessEntityPage> {
  const query = businessEntityListQuerySchema.parse(input);
  const parameters = new URLSearchParams();
  if (query.status) {
    parameters.set("status", query.status);
  }
  if (query.search) {
    parameters.set("search", query.search);
  }
  if (query.cursor) {
    parameters.set("cursor", query.cursor);
  }
  if (query.limit !== undefined) {
    parameters.set("limit", String(query.limit));
  }
  const { baseUrl, headers } = getApiConfiguration();
  const response = await fetch(
    `${baseUrl}/api/v1/business-entities?${parameters.toString()}`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(
      `Business entity request failed with status ${response.status}.`,
    );
  }

  return businessEntityPageSchema.parse(await response.json());
}
