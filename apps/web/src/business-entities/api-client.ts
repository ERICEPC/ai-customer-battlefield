import {
  type BusinessEntityListQuery,
  type BusinessEntityPage,
  businessEntityListQuerySchema,
  businessEntityPageSchema,
} from "@battlefield/contracts";

import { apiBaseUrl, withSessionCredentials } from "../api/api-configuration";

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
  const response = await fetch(
    `${apiBaseUrl()}/api/v1/business-entities?${parameters.toString()}`,
    withSessionCredentials(),
  );
  if (!response.ok) {
    throw new Error(
      `Business entity request failed with status ${response.status}.`,
    );
  }

  return businessEntityPageSchema.parse(await response.json());
}
