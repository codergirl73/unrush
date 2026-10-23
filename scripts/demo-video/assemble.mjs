// Turn out/timeline.json (screencast frames + voice clips + model waits) into out/unrush-demo.mp4.
// Model waits are cut to ~1s (a jump cut from "thinking" to the answer); everything else is real time.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(new URL(".", import.meta.url).pathname, "out");
const tl = JSON.parse(readFileSync(join(OUT, "timeline.json"), "utf8"));
const KEEP = 0.7; // seconds of each wait that stay in
const TAIL = 0.2; // and right before the answer lands

const cuts = tl.waits.map((w) => [w.start + KEEP, w.end - TAIL]).filter(([a, b]) => b > a);
const map = (t) => {
  let shift = 0;
  for (const [a, b] of cuts) {
    if (t >= a && t < b) return null;
    if (t >= b) shift += b - a;
  }
  return t - tl.start - shift;
};
const total = map(tl.end);

const frames = tl.frames
  .filter((f) => f.t >= tl.start - 0.5)
  .map((f) => ({ ...f, out: map(Math.max(f.t, tl.start)) }))
  .filter((f) => f.out !== null)
  .sort((a, b) => a.out - b.out);
frames[0].out = 0;
let list = "";
for (let i = 0; i < frames.length; i++) {
  const dur = (i + 1 < frames.length ? frames[i + 1].out : total) - frames[i].out;
  if (dur <= 0.0005) continue;
  list += `file '${frames[i].file}'\nduration ${dur.toFixed(4)}\n`;
}
list += `file '${frames.at(-1).file}'\n`;
writeFileSync(join(OUT, "frames.txt"), list);

const run = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
const fadeOut = Math.max(0, total - 1.0).toFixed(2);
run([
  "-f", "concat", "-safe", "0", "-i", join(OUT, "frames.txt"),
  "-vf", `fps=30,scale=1920:1080:flags=lanczos,format=yuv420p,fade=t=in:st=0:d=0.6,fade=t=out:st=${fadeOut}:d=1.0`,
  "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-r", "30", "-t", total.toFixed(2), join(OUT, "video.mp4"),
]);

const inputs = tl.audio.flatMap((a) => ["-i", a.file]);
const delays = tl.audio.map((a, i) => `[${i}:a]aresample=48000,adelay=${Math.round((map(a.t) ?? 0) * 1000)}:all=1[a${i}]`);
const mix = `${tl.audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${tl.audio.length}:normalize=0:dropout_transition=0,apad,atrim=0:${total.toFixed(2)},afade=t=out:st=${fadeOut}:d=1.0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
run([...inputs, "-filter_complex", [...delays, mix].join(";"), "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", join(OUT, "audio.m4a")]);

run(["-i", join(OUT, "video.mp4"), "-i", join(OUT, "audio.m4a"), "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", "-shortest", join(OUT, "unrush-demo.mp4")]);
console.log(`unrush-demo.mp4: ${total.toFixed(1)}s, ${frames.length} frames, ${tl.audio.length} voice clips, ${cuts.length} waits cut (${cuts.reduce((s, [a, b]) => s + b - a, 0).toFixed(1)}s removed)`);
