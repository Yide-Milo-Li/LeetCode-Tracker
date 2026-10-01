//! Deterministic recovery budget shared by startup and later outages.
use std::time::Duration;

#[derive(Default)]
pub struct RecoveryPolicy {
    retries: usize,
    failures: u8,
    healthy_since: Option<Duration>,
}
impl RecoveryPolicy {
    /// A brief successful launch does not earn another retry budget.
    pub fn healthy(&mut self, now: Duration) {
        self.failures = 0;
        let since = *self.healthy_since.get_or_insert(now);
        if now.saturating_sub(since) >= Duration::from_secs(60) {
            self.retries = 0;
        }
    }
    pub fn unhealthy(&mut self) -> bool {
        self.healthy_since = None;
        self.failures = self.failures.saturating_add(1);
        self.failures >= 3
    }
    pub fn outage(&mut self) {
        self.healthy_since = None;
        self.failures = 0;
    }
    pub fn next_retry(&mut self) -> Option<Duration> {
        let delay = [1, 2, 5].get(self.retries).copied()?;
        self.retries += 1;
        Some(Duration::from_secs(delay))
    }
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn short_lived_success_does_not_reset_three_retries() {
        let mut p = RecoveryPolicy::default();
        for delay in [1, 2, 5] {
            assert_eq!(p.next_retry(), Some(Duration::from_secs(delay)));
            p.healthy(Duration::from_secs(1));
            p.outage();
        }
        assert_eq!(p.next_retry(), None);
    }
    #[test]
    fn only_sixty_continuously_healthy_seconds_reset_the_budget() {
        let mut p = RecoveryPolicy::default();
        p.next_retry();
        p.healthy(Duration::ZERO);
        p.healthy(Duration::from_secs(59));
        assert_eq!(p.next_retry(), Some(Duration::from_secs(2)));
        p.unhealthy();
        p.healthy(Duration::from_secs(60));
        p.healthy(Duration::from_secs(119));
        assert_eq!(p.next_retry(), Some(Duration::from_secs(5)));
        p.healthy(Duration::from_secs(120));
        assert_eq!(p.next_retry(), Some(Duration::from_secs(1)));
    }
    #[test]
    fn recovery_requires_three_consecutive_health_failures() {
        let mut p = RecoveryPolicy::default();
        assert!(!p.unhealthy());
        assert!(!p.unhealthy());
        p.healthy(Duration::ZERO);
        assert!(!p.unhealthy());
        assert!(!p.unhealthy());
        assert!(p.unhealthy());
        p.reset();
        assert!(!p.unhealthy());
    }
}
