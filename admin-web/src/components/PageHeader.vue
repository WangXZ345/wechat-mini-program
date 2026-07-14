<script setup lang="ts">
defineProps<{ title: string; description: string }>();
</script>

<template>
  <header class="page-header">
    <div>
      <h1 class="page-header__title">{{ title }}</h1>
      <p class="page-header__description">{{ description }}</p>
    </div>
    <div class="page-header__actions">
      <slot />
    </div>
  </header>
</template>
