import type { AdminTransport } from "@/types/api";
import type { LoginDemoConfig } from "./selected-types";
import { HttpBffTransport } from "./http-transport";

export function createSelectedTransport(): AdminTransport {
  return new HttpBffTransport();
}

export const selectedLoginDemo: LoginDemoConfig | null = null;
