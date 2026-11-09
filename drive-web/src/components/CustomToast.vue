<!-- Derived from filebrowser/filebrowser@e8a388f (Apache-2.0). Modified by DaemonClient contributors. -->
<template>
  <div class="t-container">
    <span>{{ message }}</span>
    <button v-if="isReport" class="action" @click.stop="clicked">
      {{ reportText }}
    </button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  message: string;
  reportText?: string;
  isReport?: boolean;
}>();

const clicked = () => {
  window.open(
    "https://github.com/myrosama/DaemonClient/issues/new",
    "_blank",
    "noopener"
  );
};
</script>

<style scoped>
.t-container {
  width: 100%;
  padding: 5px 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.action {
  text-align: center;
  height: 40px;
  padding: 0 10px;
  margin-left: 20px;
  border-radius: 5px;
  color: white;
  cursor: pointer;
  border: thin solid currentColor;
}

html[dir="rtl"] .action {
  margin-left: initial;
  margin-right: 20px;
}
</style>
