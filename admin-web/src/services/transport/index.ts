import type { AdminTransport } from "@/types/api";
import { createSelectedTransport, selectedLoginDemo } from "virtual:admin-selected-transport";

export const transport: AdminTransport = createSelectedTransport();
export { selectedLoginDemo };
