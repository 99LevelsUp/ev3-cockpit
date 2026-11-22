//! Telling listeners about events in the order they happened.
//!
//! A producer pushes its events while it still holds its own lock, so the queue's order is the
//! order the state changed in, and tells the listeners after letting go of it, so a listener may
//! call back into the producer. Whoever finds nobody telling drains the queue; a push made while
//! someone drains, from a listener or from another thread, joins the end of the queue and is told
//! by that drain. So no listener hears a newer event before an older one, and none is told inside
//! another listener's call.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

pub type Listener<E> = Arc<dyn Fn(&E) + Send + Sync>;

pub struct Dispatcher<E> {
    queue: Mutex<VecDeque<E>>,
    listeners: Mutex<Vec<Listener<E>>>,
    draining: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<E> Default for Dispatcher<E> {
    fn default() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
            listeners: Mutex::new(Vec::new()),
            draining: AtomicBool::new(false),
        }
    }
}

impl<E> Dispatcher<E> {
    /// Adds a listener; it hears every event pushed from now on.
    pub fn listen(&self, listener: Listener<E>) {
        lock(&self.listeners).push(listener);
    }

    /// Drops every listener and every event not told yet.
    pub fn clear(&self) {
        lock(&self.listeners).clear();
        lock(&self.queue).clear();
    }

    /// Queues an event. Call it under the lock that changed the state, then [`Dispatcher::drain`]
    /// once that lock is let go.
    pub fn push(&self, event: E) {
        lock(&self.queue).push_back(event);
    }

    /// Tells the listeners every queued event, unless someone is telling them already.
    pub fn drain(&self) {
        loop {
            if self
                .draining
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return;
            }
            loop {
                let Some(event) = lock(&self.queue).pop_front() else {
                    break;
                };
                let listeners = lock(&self.listeners).clone();
                for listener in &listeners {
                    listener(&event);
                }
            }
            self.draining.store(false, Ordering::Release);
            // An event pushed after the last look and before the flag went down is told here.
            if lock(&self.queue).is_empty() {
                return;
            }
        }
    }
}
