import { computed, ref } from "vue";
import { defineStore } from "pinia";

export type DensityMode = "compact" | "comfortable";

export const useAppStore = defineStore("app", () => {
  const sidebarCollapsed = ref(window.innerWidth <= 1180);
  const density = ref<DensityMode>((window.sessionStorage.getItem("admin-web.density") as DensityMode) || "compact");

  const sidebarWidth = computed(() => (sidebarCollapsed.value ? 72 : 240));

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  function setDensity(value: DensityMode): void {
    density.value = value;
    window.sessionStorage.setItem("admin-web.density", value);
  }

  function syncViewport(): void {
    if (window.innerWidth <= 1180) sidebarCollapsed.value = true;
  }

  return { sidebarCollapsed, sidebarWidth, density, toggleSidebar, setDensity, syncViewport };
});
