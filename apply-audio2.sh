#!/usr/bin/env bash
# =====================================================================
#  apply-audio2.sh   —   audio bubble ka look
#
#  1. waveform bubble se bahar nikal rahi   -> overflow + min-width fix
#  2. duration neeche alag line par         -> usi row mein
#  3. download icon (WhatsApp mein nahi)    -> hata diya
#  4. "00:05"                               -> "0:05"
#
#  Chalane ka tareeqa (server par):
#      cd /root/staging-build
#      curl -sO https://raw.githubusercontent.com/Akopopp/ChatsSync/new-ui/apply-audio2.sh
#      bash apply-audio2.sh
#
#  Wapas lena ho to:
#      git checkout -- app/javascript/dashboard/components-next/message/chips/Audio.vue
# =====================================================================
set -euo pipefail
cd /root/staging-build

F=app/javascript/dashboard/components-next/message/chips/Audio.vue
BK=/root/backups
S=$(date +%F-%H%M%S)

say(){ printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }
ok(){  printf '   \033[1;32mOK\033[0m  %s\n' "$*"; }
die(){ printf '\n\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }

[ -f "$F" ] || die "file nahi mili: $F"
mkdir -p "$BK"
cp "$F" "$BK/chips-Audio.vue.$S.bak"
ok "backup: $BK/chips-Audio.vue.$S.bak"

say "1/3  PATCH"
python3 - "$F" <<'PYEOF'
import io, sys
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()

E = []

# --- 1. waqt ka format: 00:05 -> 0:05 ---
E.append((
"""  if (!time || Number.isNaN(time)) return '00:00';
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;""",
"""  if (!time || Number.isNaN(time)) return '0:00';
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;"""
))

# --- 2. template: waqt usi row mein, download hata do ---
E.append((
"""      <button
        class="cs-voice__speed"
        :class="{ 'cs-voice__speed--on': playbackSpeed !== 1 }"
        @click="changePlaybackSpeed"
      >
        {{ playbackSpeedLabel }}
      </button>
    </div>

    <div class="cs-voice__meta">
      <span class="cs-voice__time">{{ remainingLabel }}</span>
      <button class="cs-voice__dl" @click="downloadAudio">
        <Icon class="size-3.5" icon="i-lucide-download" />
      </button>
    </div>
""",
"""      <span class="cs-voice__time">{{ remainingLabel }}</span>

      <button
        class="cs-voice__speed"
        :class="{ 'cs-voice__speed--on': playbackSpeed !== 1 }"
        @click="changePlaybackSpeed"
      >
        {{ playbackSpeedLabel }}
      </button>
    </div>
"""
))

# --- 3. wave: overflow band karo, bars patli karo ---
E.append((
""".cs-voice__wave {
  flex: 1 1 0;
  min-width: 3rem;
  height: 1.75rem;
  display: flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
}""",
""".cs-voice__wave {
  flex: 1 1 0;
  /* min-width: 0 zaroori hai warna bars bubble se bahar bah jaati hain */
  min-width: 0;
  height: 1.75rem;
  display: flex;
  align-items: center;
  gap: 1px;
  cursor: pointer;
  overflow: hidden;
}"""
))

E.append((
""".cs-voice__bar {
  flex: 1;
  min-width: 2px;""",
""".cs-voice__bar {
  flex: 1 1 0;
  min-width: 1px;"""
))

# --- 4. player ki chaudai + purana meta CSS hatao ---
E.append((
""".cs-voice {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}""",
""".cs-voice {
  width: 100%;
  max-width: 100%;
  /* bubble ko WhatsApp jaisi chaudai de */
  min-width: 13rem;
}"""
))

E.append((
""".cs-voice__meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.125rem;
  padding-left: 2.5rem;
}

.cs-voice__time {""",
""".cs-voice__time {
  flex-shrink: 0;"""
))

for i, (o, n) in enumerate(E):
    c = s.count(o)
    assert c == 1, "block %d: match %d (chahiye 1)" % (i + 1, c)
    s = s.replace(o, n)

io.open(p, 'w', encoding='utf-8').write(s)
print("   %d/%d blocks OK" % (len(E), len(E)))
PYEOF

say "2/3  VUE COMPILER CHECK"
docker exec -u root chatssync-dev node -e "
const fs=require('fs');
const c=require('/src/node_modules/@vue/compiler-sfc');
const src=fs.readFileSync('/src/$F','utf8');
const {descriptor,errors}=c.parse(src,{filename:'Audio.vue'});
if(errors.length){console.error('PARSE FAIL');errors.forEach(e=>console.error(e.message));process.exit(1);}
try{ c.compileScript(descriptor,{id:'x'}); }
catch(e){ console.error('SCRIPT FAIL: '+e.message); process.exit(1); }
console.log('   parse + compileScript OK');
" || die "compiler FAIL — wapas: cp $BK/chips-Audio.vue.$S.bak $F"

say "3/3  Base.vue (andar wale kaale box ke liye)"
B=app/javascript/dashboard/components-next/message/bubbles/Base.vue
if [ -f "$B" ]; then
  echo "----- $B -----"
  cat "$B"
else
  echo "Base.vue nahi mila, dhoondh rahe hain:"
  find app/javascript/dashboard/components-next/message -name "Base.vue"
fi

say "HO GAYA"
echo "  git diff --stat $F"
echo "  tail -3 /tmp/vite.log      # 'built in' ka intezaar"
echo "  bash push.sh"
echo "  browser: Ctrl-Shift-R"
