interface LogTickerProps {
  displayMode: "compact" | "detail";
  latestLog: string;
  openLogs: () => Promise<void>;
  copyLogPath: () => Promise<void>;
}

export default function LogTicker({
  displayMode,
  latestLog,
  openLogs,
  copyLogPath,
}: LogTickerProps) {
  if (displayMode !== "detail") {
    return null;
  }

  return (
    <div className="log-ticker">
      <span className="log-label">LOG:</span>
      <span className="log-text" title={latestLog}>
        {latestLog}
      </span>
      <div className="log-actions">
        <button className="mini-button" onClick={() => void openLogs()} type="button">
          OPEN LOGS
        </button>
        <button className="mini-button" onClick={() => void copyLogPath()} type="button">
          COPY LOG PATH
        </button>
      </div>
    </div>
  );
}
