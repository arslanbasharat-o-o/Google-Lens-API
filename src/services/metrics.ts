export class Metrics {
  private readonly counters = new Map<string, number>();

  public increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  public get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  public render(queueDepth: number, running: number, cacheEntries: number): string {
    const lines = [
      '# HELP lens_jobs_total Total jobs observed by terminal outcome.',
      '# TYPE lens_jobs_total counter',
      `lens_jobs_total{outcome="succeeded"} ${this.get('jobs_succeeded')}`,
      `lens_jobs_total{outcome="failed"} ${this.get('jobs_failed')}`,
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
    ];
    return `${lines.join('\n')}\n`;
  }
}
