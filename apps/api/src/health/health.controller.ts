import type { HealthResponse } from "@battlefield/contracts";
import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return { status: "ok" };
  }
}
