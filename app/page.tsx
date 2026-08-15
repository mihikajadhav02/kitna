"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DEMO_REQUEST, PUBLIC_BUSINESSES } from "@/lib/businesses";

export default function Home() {
  const router = useRouter();
  const [request, setRequest] = useState(DEMO_REQUEST);
  const [selectedIds, setSelectedIds] = useState<string[]>(
    ["sanjeevani", "healthfirst", "citycare"]
  );

  function toggleBusiness(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((businessId) => businessId !== id)
        : [...current, id]
    );
  }

  function placeCalls() {
    const callId = crypto.randomUUID();
    const query = new URLSearchParams({ request });
    selectedIds.forEach((id) => query.append("ids", id));
    router.push(`/call/${callId}?${query.toString()}`);
  }

  return (
    <main className="min-h-screen bg-[#0b0f14] px-6 py-10 text-zinc-100 sm:px-10">
      <div className="mx-auto max-w-4xl">
        <p className="font-mono text-sm tracking-[0.24em] text-cyan-400">
          QUOTIENT / DIAGNOSTICS
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-6xl">
          Get comparable lab quotes.
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-7 text-zinc-400">
          An automated assistant will call the selected providers and gather
          prices. No booking or transaction will be made.
        </p>

        <section className="mt-10 border border-zinc-800 bg-[#10161d] p-5 sm:p-7">
          <label
            className="font-mono text-sm uppercase tracking-wider text-cyan-400"
            htmlFor="request"
          >
            What do you need?
          </label>
          <textarea
            id="request"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            rows={4}
            className="mt-3 w-full resize-y border border-zinc-700 bg-[#0b0f14] p-4 text-lg leading-7 outline-none focus:border-cyan-400"
          />
        </section>

        <section className="mt-6 border border-zinc-800 bg-[#10161d] p-5 sm:p-7">
          <h2 className="font-mono text-sm uppercase tracking-wider text-cyan-400">
            Providers to call
          </h2>
          <div className="mt-4 divide-y divide-zinc-800 border-y border-zinc-800">
            {PUBLIC_BUSINESSES.map((business) => (
              <label
                key={business.id}
                className="flex cursor-pointer items-center gap-4 py-4 text-lg hover:bg-white/[0.02]"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(business.id)}
                  onChange={() => toggleBusiness(business.id)}
                  className="h-5 w-5 accent-cyan-400"
                />
                <span>{business.name}</span>
                <span className="font-mono text-sm text-zinc-500">
                  {business.area}
                </span>
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={placeCalls}
            disabled={selectedIds.length === 0 || request.trim().length === 0}
            className="mt-7 w-full bg-cyan-400 px-5 py-4 text-lg font-semibold text-[#071116] hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            Place calls
          </button>
        </section>
      </div>
    </main>
  );
}
