import { createApp } from "vue";
import { ElLoading } from "element-plus";
import App from "./App.vue";
import { pinia } from "./app/pinia";
import { router } from "./router";
import { transport } from "./services/transport";
import { useAuthStore } from "./stores/auth";
import { useRealtimeStore } from "./stores/realtime";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/element.css";

const app = createApp(App);

app.directive("loading", ElLoading.directive);
app.use(pinia);

const auth = useAuthStore(pinia);
const realtime = useRealtimeStore(pinia);
transport.setSessionInvalidationHandler?.((reason) => {
  auth.invalidateSession(reason);
  realtime.stop();
  const current = router.currentRoute.value;
  if (current.name && current.name !== "login") {
    void router.replace({ name: "login", query: { redirect: current.fullPath } }).catch(() => undefined);
  }
});

app.use(router).mount("#app");
