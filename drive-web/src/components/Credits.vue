<template>
  <span class="dc-credits">
    <!-- AGPL-3.0 §13: every page links to the source -->
    <a
      rel="noopener noreferrer"
      target="_blank"
      href="https://github.com/myrosama/DaemonClient"
      >{{ name }}</a
    >
    {{ version }} · Based on
    <a
      rel="noopener noreferrer"
      target="_blank"
      href="https://github.com/filebrowser/filebrowser"
      >File Browser</a
    >
    ·
    <a rel="noopener noreferrer" target="_blank" :href="licensesURL"
      >Licences</a
    >
  </span>
</template>

<script setup lang="ts">
import { baseURL, name, version } from "@/utils/constants";

const licensesURL = `${baseURL}/THIRD_PARTY_LICENSES.txt`;
</script>
