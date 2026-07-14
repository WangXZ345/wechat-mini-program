import "vue-router";
import type { AccessRule } from "@/config/access";

declare module "vue-router" {
  interface RouteMeta {
    title?: string;
    requiresAuth?: boolean;
    access?: AccessRule;
    sensitive?: boolean;
    resource?: string;
  }
}

export {};
