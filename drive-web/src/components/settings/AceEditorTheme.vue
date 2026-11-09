<!-- Derived from filebrowser/filebrowser@e8a388f (Apache-2.0). Modified by DaemonClient contributors. -->
<template>
  <select
    name="selectAceEditorTheme"
    v-on:change="change"
    :value="aceEditorTheme"
  >
    <option v-for="theme in themes" :value="theme.theme" :key="theme.theme">
      {{ theme.name }}
    </option>
  </select>
</template>

<script setup lang="ts">
import { type SelectHTMLAttributes } from "vue";
// ext-themelist needs the global `ace`; load it first, as utils/theme.ts does.
import "ace-builds";
import { themes } from "ace-builds/src-noconflict/ext-themelist";

defineProps<{
  aceEditorTheme: string;
}>();

const emit = defineEmits<{
  (e: "update:aceEditorTheme", val: string | null): void;
}>();

const change = (event: Event) => {
  emit("update:aceEditorTheme", (event.target as SelectHTMLAttributes)?.value);
};
</script>
