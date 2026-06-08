interface MetricsGridProps {
  displayMode: "compact" | "detail";
  realModeEnabled: boolean;
  metrics: [string, string][];
  resourceMetrics: [string, string][];
  poolStatus: string;
  authStatus: string;
  jobStatus: string;
  lastShare: string;
}

export default function MetricsGrid({
  displayMode,
  realModeEnabled,
  metrics,
  resourceMetrics,
  poolStatus,
  authStatus,
  jobStatus,
  lastShare,
}: MetricsGridProps) {
  if (displayMode !== "detail") {
    return null;
  }

  return (
    <>
      <section className="metrics">
        {metrics.map(([label, value]) => (
          <article key={label}>
            <p className="label">{label}</p>
            <strong title={value}>{value}</strong>
          </article>
        ))}
      </section>

      <section className="resource-status-strip" aria-label="Resource status">
        {resourceMetrics.map(([label, value]) => (
          <span key={label}>
            <b>{label}</b>
            {value}
          </span>
        ))}
      </section>

      {realModeEnabled && (
        <section className="real-status-strip" aria-label="Real mining connection status">
          <span>
            <b>POOL</b>
            {poolStatus}
          </span>
          <span>
            <b>AUTH</b>
            {authStatus}
          </span>
          <span>
            <b>JOB</b>
            {jobStatus}
          </span>
          <span>
            <b>LAST SHARE</b>
            {lastShare}
          </span>
        </section>
      )}
    </>
  );
}
