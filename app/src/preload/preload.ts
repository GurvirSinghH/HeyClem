import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AudioClip, type ClemBridge, type PillState } from "../shared/ipc";

const bridge: ClemBridge = {
  onState: (cb) => void ipcRenderer.on(IPC.state, (_e, s: PillState) => cb(s)),
  onMicStart: (cb) => void ipcRenderer.on(IPC.micStart, () => cb()),
  onMicStop: (cb) => void ipcRenderer.on(IPC.micStop, () => cb()),
  sendMicChunk: (chunk) => ipcRenderer.send(IPC.micChunk, chunk),
  micEnded: () => ipcRenderer.send(IPC.micEnded),
  micError: (message) => ipcRenderer.send(IPC.micError, message),
  onAudioPlay: (cb) => void ipcRenderer.on(IPC.audioPlay, (_e, clip: AudioClip) => cb(clip)),
  onAudioEnd: (cb) => void ipcRenderer.on(IPC.audioEnd, (_e, turnId: number) => cb(turnId)),
  onAudioFlush: (cb) => void ipcRenderer.on(IPC.audioFlush, () => cb()),
  audioDrained: (turnId) => ipcRenderer.send(IPC.audioDrained, turnId),
};

contextBridge.exposeInMainWorld("clem", bridge);
