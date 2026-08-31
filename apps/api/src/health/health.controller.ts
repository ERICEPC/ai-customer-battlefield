import type { HealthResponse } from "@battlefield/contracts";
import { Controller, Get } from "@nestjs/common";

import { PublicRoute } from "../auth/auth.constants.js";

@Controller("health")
export class HealthController {
  @Get()
  @PublicRoute()
  getHealth(): HealthResponse {
    return { status: "ok" };
  }
}
