<template>
  <div ref="container" class="videoPlayer" role="region" tabindex="0" :aria-label="label" @keydown.self="handleKeydown" @focusin="player && (player.controls.show = true)" />
</template>

<script setup lang="ts">
import Artplayer from "artplayer";
import { onBeforeUnmount, ref, watch } from "vue";

const props = withDefaults(defineProps<{
  src: string;
  label?: string;
  poster?: string;
  autoplay?: boolean;
  muted?: boolean;
  active?: boolean;
  loop?: boolean;
}>(), { label: "视频播放器", poster: "", autoplay: false, muted: false, active: true, loop: false });
const emit = defineEmits<{ error: [error: unknown] }>();
const container = ref<HTMLDivElement>();
let player: Artplayer | undefined;

function pause() {
  player?.pause();
}

function handleKeydown(event: KeyboardEvent) {
  if (!player || !props.active || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  switch (event.code) {
    case "Space": void player.toggle(); break;
    case "ArrowLeft": player.backward = 5; break;
    case "ArrowRight": player.forward = 5; break;
    case "ArrowUp": player.volume += 0.1; break;
    case "ArrowDown": player.volume -= 0.1; break;
    default: return;
  }
  event.preventDefault();
  player.controls.show = true;
}

function destroyPlayer() {
  const current = player;
  player = undefined;
  if (!current) return;
  current.pause();
  // Artplayer 5.4 默认在 destroy 中移除 src 并 load，释放媒体后清空容器。
  current.destroy();
}

watch([container, () => props.src], ([element, src], _previous, onCleanup) => {
  onCleanup(destroyPlayer);
  if (!element || !src) return;
  try {
    const current = player = new Artplayer({
      container: element,
      url: src,
      poster: props.poster,
      autoplay: props.autoplay && props.active,
      muted: props.muted,
      loop: props.loop,
      playsInline: true,
      lang: "zh-cn",
      theme: "var(--el-color-primary)",
      setting: true,
      playbackRate: true,
      fullscreen: true,
      hotkey: false,
      moreVideoAttr: { preload: "metadata" },
    });
    current.video.setAttribute("aria-label", props.label);
    const pauseInactive = () => {
      if (player === current && !props.active) { current.video.autoplay = false; current.pause(); }
    };
    current.on("ready", pauseInactive);
    current.on("video:play", pauseInactive);
    current.on("video:error", error => { if (player === current) emit("error", error); });
  } catch (error) {
    destroyPlayer();
    emit("error", error);
  }
}, { immediate: true, flush: "post" });

watch(() => props.active, active => {
  if (!active && player) { player.video.autoplay = false; pause(); }
}, { flush: "sync" });
watch(() => props.muted, muted => { if (player) player.muted = muted; });
watch(() => props.poster, poster => { if (player) player.poster = poster; });
watch(() => props.loop, loop => { if (player) player.option.loop = loop; });
watch(() => props.label, label => { player?.video.setAttribute("aria-label", label); });
onBeforeUnmount(destroyPlayer);
defineExpose({ pause });
</script>

<style scoped lang="scss">
.videoPlayer {
  position: relative;
  isolation: isolate;
  width: 100%;
  height: 100%;
  aspect-ratio: 16 / 9;
  min-width: 0;
  min-height: 0;
}
</style>
