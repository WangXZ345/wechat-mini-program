import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { profileHasPermission } from "@/config/access";
import { ApiError, toApiError } from "@/services/http/api-error";
import { transport } from "@/services/transport";
import type { AdminProfile, LoginInput } from "@/types/auth";
import { isAdminRole } from "@/types/auth";
import type { SessionInvalidationReason } from "@/types/api";

const QUIET_BOOTSTRAP_CODES = new Set([
  "AUTH_REQUIRED",
  "ACCESS_TOKEN_REQUIRED",
  "REFRESH_TOKEN_REQUIRED",
  "SESSION_EXPIRED",
  "SESSION_REVOKED"
]);

export const useAuthStore = defineStore("auth", () => {
  const profile = ref<AdminProfile | null>(null);
  const initialized = ref(false);
  const authenticating = ref(false);
  const error = ref<ApiError | null>(null);
  let authTransitionRevision = 0;

  const isAuthenticated = computed(() => Boolean(profile.value?.isActive));

  function validateProfile(value: AdminProfile): AdminProfile {
    if (!value.isActive || !isAdminRole(value.role) || !Array.isArray(value.permissions)) {
      throw new ApiError("当前账号不能进入网页版后台", "FORBIDDEN", 403);
    }
    return value;
  }

  async function bootstrap(force = false): Promise<void> {
    if (initialized.value && !force) return;
    const transitionRevision = authTransitionRevision;
    try {
      const nextProfile = validateProfile(await transport.getCurrentProfile());
      if (transitionRevision !== authTransitionRevision) return;
      profile.value = nextProfile;
    } catch (reason) {
      if (transitionRevision !== authTransitionRevision) return;
      const apiError = toApiError(reason);
      if (!QUIET_BOOTSTRAP_CODES.has(apiError.code)) error.value = apiError;
      profile.value = null;
    } finally {
      if (transitionRevision === authTransitionRevision) initialized.value = true;
    }
  }

  async function login(input: LoginInput): Promise<void> {
    const transitionRevision = ++authTransitionRevision;
    authenticating.value = true;
    error.value = null;
    try {
      const nextProfile = validateProfile(await transport.login(input));
      if (transitionRevision !== authTransitionRevision) {
        throw new ApiError("认证状态已切换", "AUTH_TRANSITION_SUPERSEDED", 409);
      }
      profile.value = nextProfile;
      initialized.value = true;
    } catch (reason) {
      const apiError = toApiError(reason);
      if (transitionRevision === authTransitionRevision) error.value = apiError;
      throw apiError;
    } finally {
      if (transitionRevision === authTransitionRevision) authenticating.value = false;
    }
  }

  async function logout(): Promise<void> {
    authTransitionRevision += 1;
    profile.value = null;
    initialized.value = true;
    authenticating.value = false;
    error.value = null;
    try {
      await transport.logout();
    } catch {
      // Local logout is authoritative; a later login is serialized behind remote revocation.
    }
  }

  function can(permission?: string): boolean {
    return profileHasPermission(profile.value, permission);
  }

  function clearError(): void {
    error.value = null;
  }

  function invalidateSession(reason: SessionInvalidationReason): void {
    authTransitionRevision += 1;
    profile.value = null;
    initialized.value = true;
    authenticating.value = false;
    error.value = new ApiError(
      reason.message || "登录状态已失效，请重新登录",
      reason.code || "SESSION_EXPIRED",
      reason.status || 401,
      reason.requestId
    );
  }

  return {
    profile,
    initialized,
    authenticating,
    error,
    isAuthenticated,
    bootstrap,
    login,
    logout,
    can,
    clearError,
    invalidateSession
  };
});
