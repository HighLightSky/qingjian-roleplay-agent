package com.example.service;

import java.io.Closeable;
import java.io.IOException;

/** 工作线程安装取消句柄，截止计时可以主动关闭上游流，而非只改变界面状态。 */
public final class UpstreamCancellation {
    private static final ThreadLocal<UpstreamCancellation> CURRENT = new ThreadLocal<>();
    private Closeable resource;
    private boolean cancelled;

    public static UpstreamCancellation install() {
        var handle = new UpstreamCancellation();
        CURRENT.set(handle);
        return handle;
    }

    public static void clear() {
        CURRENT.remove();
    }

    public static void register(Closeable resource) throws IOException {
        var current = CURRENT.get();
        if (current != null)
            current.attach(resource);
    }

    private synchronized void attach(Closeable next) throws IOException {
        if (cancelled) {
            next.close();
            throw new IOException("上游请求已取消");
        }
        resource = next;
    }

    public synchronized void cancel() {
        cancelled = true;
        if (resource != null) {
            try {
                resource.close();
            } catch (IOException ignored) {
                /* 已关闭的连接无需再次处理。 */ }
            resource = null;
        }
    }
}
