import { useEffect, useState } from "react";

const BLOCK_HEIGHT_URLS = [
  "https://mempool.space/api/blocks/tip/height",
  "https://blockstream.info/api/blocks/tip/height",
  "https://blockchain.info/q/getblockcount",
];

export function useBlockHeight() {
  const [blockHeight, setBlockHeight] = useState("Loading...");

  useEffect(() => {
    let disposed = false;
    let activeController: AbortController | null = null;
    let requestSequence = 0;

    const getBlockHeight = async () => {
      const requestId = ++requestSequence;

      activeController?.abort();

      for (const url of BLOCK_HEIGHT_URLS) {
        if (disposed || requestId !== requestSequence) {
          return;
        }

        const controller = new AbortController();
        activeController = controller;
        const timeout = window.setTimeout(() => controller.abort(), 5_000);

        try {
          const res = await fetch(url, { signal: controller.signal });
          if (res.ok) {
            const val = await res.text();
            const num = parseInt(val.trim(), 10);
            if (!isNaN(num) && num > 0) {
              if (!disposed && requestId === requestSequence) {
                setBlockHeight(num.toLocaleString());
              }
              return;
            }
          }
        } catch (error) {
          console.warn(`Failed to fetch block height from ${url}:`, error);
        } finally {
          window.clearTimeout(timeout);
          if (activeController === controller) {
            activeController = null;
          }
        }
      }

      if (!disposed && requestId === requestSequence) {
        setBlockHeight("Offline");
      }
    };

    void getBlockHeight();
    const timer = window.setInterval(() => void getBlockHeight(), 30_000);
    return () => {
      disposed = true;
      requestSequence += 1;
      activeController?.abort();
      window.clearInterval(timer);
    };
  }, []);

  return blockHeight;
}
