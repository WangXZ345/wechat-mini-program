import type { AdminTransport } from "@/types/api";
import type { LoginDemoConfig } from "./selected-types";
import { MockTransport } from "./mock-transport";

export function createSelectedTransport(): AdminTransport {
  return new MockTransport();
}

export const selectedLoginDemo: LoginDemoConfig = {
  defaultAccount: "procurement.demo",
  defaultPassword: "demo-pass",
  accounts: [
    { label: "采购演示", value: "procurement.demo" },
    { label: "客服演示", value: "customer_service.demo" },
    { label: "财务演示", value: "finance.demo" },
    { label: "超级管理员演示", value: "super_admin.demo" }
  ]
};
