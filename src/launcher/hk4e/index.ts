import { batch, createSignal } from "solid-js";
import { CommonUpdateProgram } from "../../common-update-ui";
import { ChannelClient, ChannelClientInstallState } from "../channel-client";
import {
  Server,
  ServerContentData,
  ServerVersionData,
  VoicePackNames,
} from "../../constants";
import { Locale } from "../../locale";
import {
  assertValueDefined,
  getFreeSpace,
  getKey,
  getKeyOrDefault,
  readBinary,
  setKey,
  stats,
  waitImageReady,
} from "../../utils";
import { join } from "path-browserify";
import { gt, lt } from "semver";
import { Config } from "../config";
import { checkIntegrityProgram } from "./program-check-integrity";
import {
  predownloadGameProgram,
  updateGameProgram,
} from "./program-update-game";
import { downloadAndInstallGameProgram } from "./program-install-game";
import { launchGameProgram } from "./program-launch-game";
import { patchRevertProgram } from "./patch";
import { Aria2 } from "../../aria2";
import { Wine } from "../../wine";
import {
  checkAndDownloadDXVK,
  checkAndDownloadFpsUnlocker,
} from "../../downloadable-resource";
import { checkAndDownloadReshade } from "../../reshade";

const CURRENT_SUPPORTED_VERSION = "3.6.0";

export async function createHK4EChannelClient({
  server,
  locale,
  aria2,
  wine,
}: {
  server: Server;
  locale: Locale;
  aria2: Aria2;
  wine: Wine;
}): Promise<ChannelClient> {
  const {
    data: {
      adv: { background, url, icon },
    },
  }: ServerContentData = await (
    await fetch(
      server.adv_url +
        (server.id == "CN"
          ? `&language=zh-cn` // CN server has no other language support
          : `&language=${locale.get("CONTENT_LANG_ID")}`)
    )
  ).json();
  const {
    data: {
      game: {
        diffs,
        latest: {
          version: GAME_LATEST_VERSION,
          path,
          decompressed_path,
          voice_packs,
          size,
        },
      },
      pre_download_game,
    },
  }: ServerVersionData = await getLatestVersionInfo(server);
  await waitImageReady(background);

  const { gameInstalled, gameInstallDir, gameVersion } = await checkGameState(
    locale,
    server
  );

  const [installed, setInstalled] = createSignal<ChannelClientInstallState>(
    gameInstalled ? "INSTALLED" : "NOT_INSTALLED"
  );
  const [showPredownloadPrompt, setShowPredownloadPrompt] =
    createSignal<boolean>(
      pre_download_game != null && //exist pre_download_game data in server response
        (await getKeyOrDefault("predownloaded_all", "NOTFOUND")) ==
          "NOTFOUND" && // not downloaded yet
        gameInstalled && // game installed
        gt(pre_download_game.latest.version, gameVersion) // predownload version is greater
    );
  const [_gameInstallDir, setGameInstallDir] = createSignal(
    gameInstallDir ?? ""
  );
  const [gameCurrentVersion, setGameVersion] = createSignal(
    gameVersion ?? "0.0.0"
  );
  const updateRequired = () => lt(gameCurrentVersion(), GAME_LATEST_VERSION);
  return {
    installState: installed,
    showPredownloadPrompt,
    installDir: _gameInstallDir,
    updateRequired,
    uiContent: {
      background,
      iconImage: icon,
      url,
    },
    predownloadVersion: () => pre_download_game?.latest.version ?? "",
    dismissPredownload() {
      setShowPredownloadPrompt(false);
    },
    async *install(selection: string): CommonUpdateProgram {
      try {
        await stats(join(selection, "pkg_version"));
      } catch {
        const freeSpaceGB = await getFreeSpace(selection, "g");
        const requiredSpaceGB =
          Math.ceil(parseInt(size) / Math.pow(1024, 3)) * 1.2;
        if (freeSpaceGB < requiredSpaceGB) {
          await locale.alert(
            "NO_ENOUGH_DISKSPACE",
            "NO_ENOUGH_DISKSPACE_DESC",
            [requiredSpaceGB + "", (requiredSpaceGB * 1.074).toFixed(1)]
          );
          return;
        }

        yield* downloadAndInstallGameProgram({
          aria2,
          gameDir: selection,
          gameFileZip: path,
          // gameAudioZip: voice_packs.find((x) => x.language == "zh-cn")!
          //   .path,
          gameVersion: GAME_LATEST_VERSION,
          server,
        });
        // setGameInstalled
        batch(() => {
          setInstalled("INSTALLED");
          setGameInstallDir(selection);
          setGameVersion(GAME_LATEST_VERSION);
        });
        await setKey("game_install_dir", selection);
        return;
      }
      const gameVersion = await getGameVersion(join(selection, server.dataDir));
      if (gt(gameVersion, CURRENT_SUPPORTED_VERSION)) {
        await locale.alert(
          "UNSUPPORTED_VERSION",
          "PLEASE_WAIT_FOR_LAUNCHER_UPDATE",
          [gameVersion]
        );
        return;
      } else if (lt(gameVersion, GAME_LATEST_VERSION)) {
        const updateTarget = diffs.find(x => x.version == gameVersion);
        if (!updateTarget) {
          await locale.prompt(
            "UNSUPPORTED_VERSION",
            "GAME_VERSION_TOO_OLD_DESC",
            [gameVersion]
          );
          return;
        }
        batch(() => {
          setInstalled("INSTALLED");
          setGameInstallDir(selection);
          setGameVersion(gameVersion);
        });
        await setKey("game_install_dir", selection);
        // FIXME: perform a integrity check?
      } else {
        yield* checkIntegrityProgram({
          aria2,
          gameDir: selection,
          remoteDir: decompressed_path,
        });
        // setGameInstalled
        batch(() => {
          setInstalled("INSTALLED");
          setGameInstallDir(selection);
          setGameVersion(gameVersion);
        });
        await setKey("game_install_dir", selection);
      }
    },
    async *predownload() {
      setShowPredownloadPrompt(false);
      if (pre_download_game == null) return;
      const updateTarget = pre_download_game.diffs.find(
        x => x.version == gameCurrentVersion()
      );
      if (updateTarget == null) return;
      const voicePacks = (
        await Promise.all(
          updateTarget.voice_packs.map(async x => {
            try {
              await stats(
                join(
                  _gameInstallDir(),
                  `Audio_${VoicePackNames[x.language]}_pkg_version`
                )
              );
              return x;
            } catch {
              return null;
            }
          })
        )
      )
        .filter(x => x != null)
        .map(x => {
          assertValueDefined(x);
          return x;
        });
      yield* predownloadGameProgram({
        aria2,
        updateFileZip: updateTarget.path,
        gameDir: _gameInstallDir(),
        updateVoicePackZips: voicePacks.map(x => x.path),
      });
    },
    async *update() {
      const updateTarget = diffs.find(x => x.version == gameCurrentVersion());
      if (!updateTarget) {
        await locale.prompt(
          "UNSUPPORTED_VERSION",
          "GAME_VERSION_TOO_OLD_DESC",
          [gameCurrentVersion()]
        );
        batch(() => {
          setInstalled("NOT_INSTALLED");
          setGameInstallDir("");
          setGameVersion("0.0.0");
        });
        await setKey("game_install_dir", null);
        return;
      }
      const voicePacks = (
        await Promise.all(
          updateTarget.voice_packs.map(async x => {
            try {
              await stats(
                join(
                  _gameInstallDir(),
                  `Audio_${VoicePackNames[x.language]}_pkg_version`
                )
              );
              return x;
            } catch {
              return null;
            }
          })
        )
      )
        .filter(x => x != null)
        .map(x => {
          assertValueDefined(x);
          return x;
        });
      yield* updateGameProgram({
        aria2,
        server,
        currentGameVersion: gameCurrentVersion(),
        updatedGameVersion: GAME_LATEST_VERSION,
        updateFileZip: updateTarget.path,
        gameDir: _gameInstallDir(),
        updateVoicePackZips: voicePacks.map(x => x.path),
      });
      batch(() => {
        setGameVersion(GAME_LATEST_VERSION);
      });
    },
    async *launch(config: Config) {
      if (
        gt(gameCurrentVersion(), CURRENT_SUPPORTED_VERSION) &&
        !config.patchOff
      ) {
        await locale.alert(
          "UNSUPPORTED_VERSION",
          "PLEASE_WAIT_FOR_LAUNCHER_UPDATE",
          [gameCurrentVersion()]
        );
        return;
      }
      if (config.reshade) {
        yield* checkAndDownloadReshade(aria2, wine, _gameInstallDir());
      }
      yield* checkAndDownloadDXVK(aria2);
      if (config.fpsUnlock != "default") {
        yield* checkAndDownloadFpsUnlocker(aria2);
      }
      yield* launchGameProgram({
        gameDir: _gameInstallDir(),
        wine,
        gameExecutable: server.executable,
        config,
        server,
      });
    },
    async *checkIntegrity() {
      yield* checkIntegrityProgram({
        aria2,
        gameDir: _gameInstallDir(),
        remoteDir: decompressed_path,
      });
    },
    async *init(config: Config) {
      try {
        await getKey("patched");
      } catch {
        return;
      }
      try {
        yield* patchRevertProgram(
          _gameInstallDir(),
          wine.prefix,
          server,
          config
        );
      } catch {
        yield* checkIntegrityProgram({
          aria2,
          gameDir: _gameInstallDir(),
          remoteDir: decompressed_path,
        });
      }
    },
  };
}

async function checkGameState(locale: Locale, server: Server) {
  let gameDir = "";
  try {
    gameDir = await getKey("game_install_dir");
  } catch {
    return {
      gameInstalled: false,
    } as const;
  }
  try {
    return {
      gameInstalled: true,
      gameInstallDir: gameDir,
      gameVersion: await getGameVersion(join(gameDir, server.dataDir)),
    } as const;
  } catch {
    return {
      gameInstalled: false,
    } as const;
  }
}

async function getLatestVersionInfo(
  server: Server
): Promise<ServerVersionData> {
  const ret: ServerVersionData = await (await fetch(server.update_url)).json();
  return ret;
}

async function getGameVersion(gameDataDir: string) {
  const ggmPath = join(gameDataDir, "globalgamemanagers");
  const view = new Uint8Array(await readBinary(ggmPath));
  const index = patternSearch(
    view,
    [
      0x69, 0x63, 0x2e, 0x61, 0x70, 0x70, 0x2d, 0x63, 0x61, 0x74, 0x65, 0x67,
      0x6f, 0x72, 0x79, 0x2e,
    ]
  );
  if (index == -1) {
    throw new Error("pattern not found"); //FIXME
  } else {
    const len = index + 120;
    const v = new DataView(view.buffer);
    const strlen = v.getUint32(len, true);
    const str = String.fromCharCode(...view.slice(len + 4, len + strlen + 4));
    return str.split("_")[0];
  }
}

function patternSearch(view: Uint8Array, pattern: number[]) {
  retry: for (let i = 0; i < view.byteLength - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (view[i + j] != pattern[j]) continue retry;
    }
    return i + pattern.length;
  }
  return -1;
}