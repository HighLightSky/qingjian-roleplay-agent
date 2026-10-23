"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  FileTextIcon,
  LeafIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { guideSections } from "./navigation";

export function GuideShell({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const [active, setActive] = useState<string>("overview");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { root: root.current, rootMargin: "-80px 0px -65% 0px", threshold: 0 },
    );
    root
      .current!.querySelectorAll("article > section[id]")
      .forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  function contents(mobile: boolean) {
    return guideSections.map((section, index) => (
      <a
        key={section.id}
        href={`#${section.id}`}
        aria-current={active === section.id ? "location" : undefined}
        onClick={() => {
          setActive(section.id);
          if (mobile) menu.current!.open = false;
        }}
        className={cn(
          "flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent",
          active === section.id
            ? "bg-sidebar-accent text-primary"
            : "text-muted-foreground",
        )}
      >
        <span className="font-mono text-[11px] opacity-70">
          {String(index + 1).padStart(2, "0")}
        </span>
        {section.title}
      </a>
    ));
  }

  return (
    <div
      ref={root}
      className="backend-guide h-dvh overflow-y-auto bg-background"
    >
      <a
        href="#guide-content"
        className="sr-only z-50 rounded-md bg-background p-3 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        跳到文档正文
      </a>
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur-sm print:hidden">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-8">
          <Link
            href="/"
            className="flex items-center gap-2 text-primary"
            aria-label="青笺首页"
          >
            <LeafIcon className="size-5" />
            <span className="font-semibold tracking-widest">青笺</span>
            <span className="mx-2 h-4 border-l" />
            <span className="text-sm font-normal tracking-normal text-muted-foreground">
              开发手记
            </span>
          </Link>
          <Button variant="ghost" className="h-10" asChild>
            <Link href="/">
              <ArrowLeftIcon />
              返回对话
            </Link>
          </Button>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-4 sm:px-8 lg:flex lg:gap-12">
        <aside className="sticky top-24 mt-10 hidden h-[calc(100dvh-8rem)] w-56 shrink-0 flex-col overflow-y-auto lg:flex print:hidden">
          <p className="mb-4 flex items-center gap-2 px-3 text-xs font-medium text-muted-foreground">
            <FileTextIcon className="size-3.5" />
            阅读目录
          </p>
          <nav aria-label="文档目录">{contents(false)}</nav>
          <p className="mt-7 border-t px-3 pt-5 text-xs leading-6 text-muted-foreground">
            从当前源码出发。
            <br />
            先理解职责，再追踪实现。
          </p>
        </aside>
        <main id="guide-content" className="min-w-0 flex-1 pb-20 pt-7 sm:pt-12">
          <details
            ref={menu}
            className="mb-8 rounded-md border bg-card lg:hidden print:hidden"
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 text-sm">
              阅读目录 · 10 个章节
              <ChevronDownIcon className="size-4" />
            </summary>
            <nav
              aria-label="手机文档目录"
              className="grid gap-1 border-t p-2 sm:grid-cols-2"
            >
              {contents(true)}
            </nav>
          </details>
          <article className="guide-article mx-auto max-w-3xl">
            {children}
          </article>
        </main>
      </div>
    </div>
  );
}
