package com.example;

import java.time.*;

public final class MutableClock extends Clock {
    private Instant now = Instant.parse("2026-10-22T00:00:00Z");
    public void advance(Duration duration) { now = now.plus(duration); }
    @Override public ZoneId getZone() { return ZoneOffset.UTC; }
    @Override public Clock withZone(ZoneId zone) { return this; }
    @Override public Instant instant() { return now; }
}
