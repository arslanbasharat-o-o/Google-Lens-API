export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly observations = new Map<string, number[]>();

  public increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  public get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  public observe(name: string, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const values = this.observations.get(name) ?? [];
    values.push(value);
    // Keep operational memory bounded while retaining enough samples for a
    // useful local percentile signal.
    if (values.length > 10_000) values.splice(0, values.length - 10_000);
    this.observations.set(name, values);
  }

  public percentile(name: string, percentile: number): number {
    const values = this.observations.get(name) ?? [];
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1));
    return sorted[index] ?? 0;
  }

  public render(queueDepth: number, running: number, cacheEntries: number): string {
    const lines = [
      '# HELP lens_jobs_total Total jobs observed by terminal outcome.',
      '# TYPE lens_jobs_total counter',
      `lens_jobs_total{outcome="succeeded"} ${this.get('jobs_succeeded')}`,
      `lens_jobs_total{outcome="failed"} ${this.get('jobs_failed')}`,
      `lens_jobs_total{outcome="retried"} ${this.get('jobs_retried')}`,
      `lens_jobs_total{outcome="dead_lettered"} ${this.get('jobs_dead_lettered')}`,
      '# HELP lens_provider_failures_total Provider failure classifications.',
      '# TYPE lens_provider_failures_total counter',
      ...['challenge', 'loading', 'empty', 'parser', 'browser', 'timeout'].map(
        (kind) => `lens_provider_failures_total{kind="${kind}"} ${this.get(`failures_${kind}`)}`,
      ),
      '# HELP lens_jobs_submitted_total Jobs accepted by the HTTP service.',
      '# TYPE lens_jobs_submitted_total counter',
      `lens_jobs_submitted_total ${this.get('jobs_submitted')}`,
      '# HELP lens_job_cache_hits_total Successful jobs served from the result cache.',
      '# TYPE lens_job_cache_hits_total counter',
      `lens_job_cache_hits_total ${this.get('cache_hits')}`,
      '# HELP lens_queue_depth Number of tasks waiting for a worker.',
      '# TYPE lens_queue_depth gauge',
      `lens_queue_depth ${queueDepth}`,
      '# HELP lens_workers_running Number of workers currently processing a task.',
      '# TYPE lens_workers_running gauge',
      `lens_workers_running ${running}`,
      '# HELP lens_result_cache_entries Current result cache entries.',
      '# TYPE lens_result_cache_entries gauge',
      `lens_result_cache_entries ${cacheEntries}`,
      ...this.renderPercentiles('job_latency_ms'),
      ...this.renderPercentiles('queue_wait_ms'),
      ...this.renderPercentiles('adapter_latency_ms'),
      ...this.renderPercentiles('browser_startup_ms'),
      ...this.renderPercentiles('result_extraction_ms'),
    ];
    return `${lines.join('\n')}\n`;
  }

  private renderPercentiles(name: string): string[] {
    const metricName = `lens_${name}`;
    return [
      `# TYPE ${metricName} gauge`,
      `${metricName}{quantile="0.5"} ${this.percentile(name, 0.5)}`,
      `${metricName}{quantile="0.9"} ${this.percentile(name, 0.9)}`,
      `${metricName}{quantile="0.95"} ${this.percentile(name, 0.95)}`,
      `${metricName}{quantile="0.99"} ${this.percentile(name, 0.99)}`,
    ];
  }
}
