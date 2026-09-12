const { contextBridge, ipcRenderer } = require("electron");

// Set up contextBridge for ipcRenderer communications
const listenerWrappers = new Map();

const getChannelListeners = (channel) => {
  if (!listenerWrappers.has(channel)) {
    listenerWrappers.set(channel, new Map());
  }
  return listenerWrappers.get(channel);
};

contextBridge.exposeInMainWorld("electron", {
  ipcRenderer: {
    invoke: (channel, data) => ipcRenderer.invoke(channel, data),
    send: (channel, data) => ipcRenderer.send(channel, data),
    on: (channel, callback) => {
      const channelListeners = getChannelListeners(channel);
      const existing = channelListeners.get(callback);
      if (existing) return existing.unsubscribe;

      const wrapper = (event, ...args) => callback(...args);
      const unsubscribe = () => {
        ipcRenderer.removeListener(channel, wrapper);
        if (channelListeners.get(callback)?.wrapper === wrapper) {
          channelListeners.delete(callback);
          if (channelListeners.size === 0) listenerWrappers.delete(channel);
        }
      };
      channelListeners.set(callback, { wrapper, unsubscribe });
      ipcRenderer.on(channel, wrapper);
      return unsubscribe;
    },
    removeAllListeners: (channel) => {
      listenerWrappers.delete(channel);
      ipcRenderer.removeAllListeners(channel);
    },
    removeListener: (channel, callback) => {
      const channelListeners = listenerWrappers.get(channel);
      channelListeners?.get(callback)?.unsubscribe();
    },
  },
});
