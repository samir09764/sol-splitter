import React, { useState, useEffect, useCallback } from "react";
import { Wallet, Plus, Trash2, Zap, CheckCircle2, XCircle, Loader2, AlertTriangle, ExternalLink } from "lucide-react";

// ---------------------------------------------------------------------------
// SOL Splitter — swap one SOL balance into up to 10 tokens in as few
// transactions as Solana's size/compute limits allow.
// Created by Samir
// ---------------------------------------------------------------------------

const SOL_MINT = "So11111111111111111111111111111111111111112";
// Jupiter deprecated the old quote-api.jup.ag/v6 endpoints — using the
// current free lite-api endpoints instead.
const JUP_QUOTE_API = "https://lite-api.jup.ag/swap/v1/quote";
const JUP_SWAP_INSTRUCTIONS_API = "https://lite-api.jup.ag/swap/v1/swap-instructions";

function shortAddr(a) {
  if (!a) return "";
  return a.slice(0, 4) + "…" + a.slice(-4);
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

// Wraps fetch with a hard timeout so a slow/unresponsive endpoint fails
// loudly instead of leaving the UI stuck on "Building transactions…".
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// A single row: a target mint + a weight (%). Weights are normalized to 100.
function emptyRow() {
  return { id: uid(), mint: "", symbol: "", weight: 10, status: "idle", error: "" };
}

export default function SolSplitter() {
  const [wallet, setWallet] = useState(null); // { publicKey, provider, label }
  const [connecting, setConnecting] = useState(false);
  const [solAmount, setSolAmount] = useState("0.5");
  const [destWallet, setDestWallet] = useState("");
  const [rows, setRows] = useState(() =>
    Array.from({ length: 4 }, () => emptyRow())
  );
  const [slippageBps, setSlippageBps] = useState(100); // 1%
  const [phase, setPhase] = useState("idle"); // idle | quoting | building | signing | sending | done | error
  const [log, setLog] = useState([]);
  const [txSigs, setTxSigs] = useState([]);
  const [batches, setBatches] = useState(null); // computed plan preview

  const totalWeight = rows.reduce((s, r) => s + (Number(r.weight) || 0), 0);

  function pushLog(msg, kind = "info") {
    setLog((l) => [...l, { id: uid(), msg, kind, t: new Date().toLocaleTimeString() }]);
  }

  // --- Wallet connection -----------------------------------------------
  const detectProviders = () => {
    const found = [];
    if (typeof window !== "undefined") {
      if (window.phantom?.solana?.isPhantom) found.push({ key: "phantom", label: "Phantom", obj: window.phantom.solana });
      else if (window.solana?.isPhantom) found.push({ key: "phantom", label: "Phantom", obj: window.solana });
      if (window.solflare?.isSolflare) found.push({ key: "solflare", label: "Solflare", obj: window.solflare });
    }
    return found;
  };

  const [availableProviders, setAvailableProviders] = useState([]);
  useEffect(() => {
    setAvailableProviders(detectProviders());
  }, []);

  async function connectWallet(providerInfo) {
    setConnecting(true);
    try {
      const resp = await providerInfo.obj.connect();
      const pubkey = resp.publicKey?.toString() || providerInfo.obj.publicKey?.toString();
      setWallet({ publicKey: pubkey, provider: providerInfo.obj, label: providerInfo.label });
      pushLog(`Connected ${providerInfo.label}: ${shortAddr(pubkey)}`, "success");
    } catch (e) {
      pushLog(`Connection failed: ${e.message || e}`, "error");
    } finally {
      setConnecting(false);
    }
  }

  function disconnectWallet() {
    try {
      wallet?.provider?.disconnect?.();
    } catch (_) {}
    setWallet(null);
  }

  // --- Row management -----------------------------------------------
  function updateRow(id, patch) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function addRow() {
    if (rows.length >= 10) return;
    setRows((rs) => [...rs, emptyRow()]);
  }
  function removeRow(id) {
    setRows((rs) => rs.filter((r) => r.id !== id));
  }
  function distributeEvenly() {
    const n = rows.length || 1;
    const base = Math.floor((100 / n) * 100) / 100;
    setRows((rs) =>
      rs.map((r, i) => ({
        ...r,
        weight: i === rs.length - 1 ? Math.round((100 - base * (n - 1)) * 100) / 100 : base,
      }))
    );
  }

  // --- Core swap flow -----------------------------------------------
  const validRows = rows.filter((r) => r.mint.trim().length >= 32);

  async function runSwap() {
    setLog([]);
    setTxSigs([]);
    setBatches(null);

    if (!wallet) {
      pushLog("Connect a wallet first.", "error");
      return;
    }
    if (validRows.length === 0) {
      pushLog("Add at least one valid token mint address.", "error");
      return;
    }
    if (Math.abs(totalWeight - 100) > 0.5) {
      pushLog(`Allocation must total 100% (currently ${totalWeight.toFixed(1)}%).`, "error");
      return;
    }
    const lamportsTotal = Math.floor(parseFloat(solAmount) * 1e9);
    if (!lamportsTotal || lamportsTotal <= 0) {
      pushLog("Enter a valid SOL amount.", "error");
      return;
    }
    if (destWallet.trim()) {
      try {
        const web3check = await importWeb3();
        new web3check.PublicKey(destWallet.trim());
      } catch (e) {
        pushLog(
          `Destination wallet address is invalid — please check it for typos or extra characters. (${e.message || e})`,
          "error"
        );
        return;
      }
    }

    try {
      setPhase("quoting");
      pushLog(`Fetching quotes for ${validRows.length} tokens from Jupiter…`);

      const quotes = [];
      for (const row of validRows) {
        const lamports = Math.floor(lamportsTotal * (Number(row.weight) / 100));
        if (lamports <= 0) continue;
        updateRow(row.id, { status: "quoting" });
        try {
          const url = `${JUP_QUOTE_API}?inputMint=${SOL_MINT}&outputMint=${row.mint.trim()}&amount=${lamports}&slippageBps=${slippageBps}`;
          const res = await fetchWithTimeout(url);
          if (!res.ok) throw new Error(`quote HTTP ${res.status}`);
          const q = await res.json();
          if (q.error) throw new Error(q.error);
          quotes.push({ row, lamports, quote: q, outAmount: q.outAmount });
          updateRow(row.id, { status: "quoted" });
          pushLog(`Quote OK for ${shortAddr(row.mint)} (${row.weight}% → ${(lamports / 1e9).toFixed(4)} SOL)`, "success");
        } catch (e) {
          updateRow(row.id, { status: "error", error: e.message || String(e) });
          pushLog(`Quote failed for ${shortAddr(row.mint)}: ${e.message || e}`, "error");
        }
      }

      if (quotes.length === 0) {
        pushLog("No valid quotes returned. Check token mint addresses and try again.", "error");
        setPhase("error");
        return;
      }

      // --- Build swap INSTRUCTIONS (not full transactions) so we can merge
      // multiple tokens into a single transaction -----------------------
      setPhase("building");
      pushLog("Requesting swap instructions from Jupiter…");

      const web3 = await importWeb3();
      const { VersionedTransaction, TransactionMessage, PublicKey, ComputeBudgetProgram } = web3;
      const conn = new web3.Connection("https://solana-rpc.publicnode.com", "confirmed");

      const built = [];
      for (const { row, quote, outAmount } of quotes) {
        try {
          const body = {
            quoteResponse: quote,
            userPublicKey: wallet.publicKey,
            wrapAndUnwrapSol: true,
          };
          const res = await fetchWithTimeout(JUP_SWAP_INSTRUCTIONS_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          // If forwarding to a destination wallet, we need the token's
          // decimals for a TransferChecked instruction — fetch once here.
          let decimals = null;
          if (destWallet.trim()) {
            const mintInfo = await conn.getParsedAccountInfo(new PublicKey(row.mint.trim()));
            decimals = mintInfo?.value?.data?.parsed?.info?.decimals ?? null;
            if (decimals == null) throw new Error("could not read token decimals for transfer");
          }

          built.push({ row: { ...row, outAmount, decimals }, data });
          updateRow(row.id, { status: "built" });
        } catch (e) {
          updateRow(row.id, { status: "error", error: e.message || String(e) });
          pushLog(`Build failed for ${shortAddr(row.mint)}: ${e.message || e}`, "error");
        }
      }

      if (built.length === 0) {
        pushLog("Could not build any swap instructions.", "error");
        setPhase("error");
        return;
      }

      // --- SPL Token program constants & instruction builders, needed to
      // forward swapped tokens to a destination wallet in the same
      // transaction (no extra library — built directly from the well-known
      // Token Program layout). -------------------------------------------
      const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
      const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111111111112");

      async function getAta(mint, owner) {
        const [ata] = await PublicKey.findProgramAddress(
          [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        return ata;
      }

      function createAtaIdempotentIx(payer, owner, mint, ata) {
        // Instruction 1 = "CreateIdempotent" on the Associated Token Account program:
        // safe to include even if the account already exists (no-op in that case).
        return new web3.TransactionInstruction({
          programId: ASSOCIATED_TOKEN_PROGRAM_ID,
          keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: ata, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: new Uint8Array([1]),
        });
      }

      function transferCheckedIx(source, mint, destination, owner, amount, decimals) {
        // Instruction 12 = TransferChecked on the Token program.
        const data = new Uint8Array(10);
        data[0] = 12;
        new DataView(data.buffer).setBigUint64(1, BigInt(amount), true);
        data[9] = decimals;
        return new web3.TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [
            { pubkey: source, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: destination, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: true, isWritable: false },
          ],
          data,
        });
      }

      // Try to combine tokens into as few transactions as possible.
      // Start at MAX_BATCH per transaction; if a batch is too large to fit
      // Solana's size/compute limit, automatically split that batch smaller
      // and retry — so a swap never fails outright just because the batch
      // size was too optimistic.
      const MAX_BATCH = 5;

      async function buildGroupTx(group, blockhash) {
        const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
        const lookupTablePromises = [];
        const seenLuts = new Set();

        const destPubkey = destWallet.trim() ? new PublicKey(destWallet.trim()) : null;
        const ownerPubkey = new PublicKey(wallet.publicKey);

        for (const { data, row } of group) {
          (data.setupInstructions || []).forEach((ix) => ixs.push(toIx(ix)));
          if (data.swapInstruction) ixs.push(toIx(data.swapInstruction));
          if (data.cleanupInstruction) ixs.push(toIx(data.cleanupInstruction));
          for (const addr of data.addressLookupTableAddresses || []) {
            if (!seenLuts.has(addr)) {
              seenLuts.add(addr);
              lookupTablePromises.push(addr);
            }
          }

          // Forward the swapped token to the destination wallet, if set.
          if (destPubkey && row.decimals != null && row.outAmount != null) {
            const mintPubkey = new PublicKey(row.mint.trim());
            const sourceAta = await getAta(mintPubkey, ownerPubkey);
            const destAta = await getAta(mintPubkey, destPubkey);
            ixs.push(createAtaIdempotentIx(ownerPubkey, destPubkey, mintPubkey, destAta));
            ixs.push(transferCheckedIx(sourceAta, mintPubkey, destAta, ownerPubkey, row.outAmount, row.decimals));
          }
        }
        return { ixs, lutAddrs: lookupTablePromises };
      }

      async function tryCompile(group, blockhash) {
        const { ixs, lutAddrs } = await buildGroupTx(group, blockhash);
        const lookupTables = [];
        for (const addr of lutAddrs) {
          const lut = await conn.getAddressLookupTable(new PublicKey(addr));
          if (lut.value) lookupTables.push(lut.value);
        }
        const msg = new TransactionMessage({
          payerKey: new PublicKey(wallet.publicKey),
          recentBlockhash: blockhash,
          instructions: ixs,
        }).compileToV0Message(lookupTables);
        const vtx = new VersionedTransaction(msg);
        // Solana's hard cap is 1232 bytes for the serialized transaction.
        const size = vtx.serialize().length;
        if (size > 1232) throw new Error(`transaction too large (${size} bytes)`);
        return vtx;
      }

      // Helper: decode a base64 string into a Uint8Array without relying on
      // Node's Buffer (not available in the browser).
      function base64ToBytes(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      }

      // Helper: turn Jupiter's instruction JSON into a web3.js TransactionInstruction
      function toIx(ix) {
        return new web3.TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: ix.accounts.map((a) => ({
            pubkey: new PublicKey(a.pubkey),
            isSigner: a.isSigner,
            isWritable: a.isWritable,
          })),
          data: base64ToBytes(ix.data),
        });
      }

      const { blockhash } = await conn.getLatestBlockhash("finalized");

      // Recursively try a batch at decreasing sizes until it compiles, or
      // fall back to one-per-transaction if nothing else fits.
      async function resolveGroup(items) {
        if (items.length === 0) return [];
        try {
          const vtx = await tryCompile(items, blockhash);
          return [{ rows: items.map((g) => g.row), tx: vtx }];
        } catch (e) {
          if (items.length === 1) throw e; // can't split further
          const mid = Math.ceil(items.length / 2);
          const left = await resolveGroup(items.slice(0, mid));
          const right = await resolveGroup(items.slice(mid));
          return [...left, ...right];
        }
      }

      const initialGroups = [];
      for (let i = 0; i < built.length; i += MAX_BATCH) {
        initialGroups.push(built.slice(i, i + MAX_BATCH));
      }
      pushLog(`Trying to combine ${built.length} token swap(s) into as few transactions as possible (up to ${MAX_BATCH} per tx)…`);

      const groupTxs = [];
      for (const group of initialGroups) {
        try {
          const resolved = await resolveGroup(group);
          resolved.forEach((g) => {
            groupTxs.push(g);
            g.rows.forEach((row) => updateRow(row.id, { status: "built" }));
          });
          if (resolved.length > 1) {
            pushLog(`A batch of ${group.length} didn't fit in one transaction — split into ${resolved.length}.`, "info");
          }
        } catch (e) {
          group.forEach(({ row }) =>
            updateRow(row.id, { status: "error", error: `Could not build even as a single swap: ${e.message || e}` })
          );
          pushLog(`Batch failed entirely: ${e.message || e}`, "error");
        }
      }

      if (groupTxs.length === 0) {
        pushLog("Could not build any combined transactions.", "error");
        setPhase("error");
        return;
      }

      setBatches(groupTxs.map((g) => ({ mints: g.rows.map((r) => r.mint) })));

      setPhase("signing");
      pushLog(`Ready to sign ${groupTxs.length} transaction(s) covering ${built.length} token(s). Your wallet will prompt for each.`);

      const sigs = [];
      for (const { rows: groupRows, tx } of groupTxs) {
        try {
          groupRows.forEach((row) => updateRow(row.id, { status: "signing" }));

          let signature;
          if (wallet.provider.signAndSendTransaction) {
            const result = await wallet.provider.signAndSendTransaction(tx);
            signature = result.signature || result;
          } else {
            const signed = await wallet.provider.signTransaction(tx);
            signature = await wallet.provider.request?.({
              method: "sendTransaction",
              params: [signed.serialize()],
            });
          }

          groupRows.forEach((row) => {
            sigs.push({ mint: row.mint, signature });
            updateRow(row.id, { status: "done" });
          });
          pushLog(
            `Sent batch of ${groupRows.length} token(s) (${groupRows.map((r) => shortAddr(r.mint)).join(", ")}) → tx ${shortAddr(signature)}`,
            "success"
          );
        } catch (e) {
          groupRows.forEach((row) => updateRow(row.id, { status: "error", error: e.message || String(e) }));
          pushLog(`Sign/send failed for batch (${groupRows.map((r) => shortAddr(r.mint)).join(", ")}): ${e.message || e}`, "error");
        }
      }

      setTxSigs(sigs);
      setPhase(sigs.length > 0 ? "done" : "error");
      pushLog(
        sigs.length === validRows.length
          ? `All ${validRows.length} token swap(s) sent across ${groupTxs.length} transaction(s).`
          : `${sigs.length}/${validRows.length} swaps sent across ${groupTxs.length} transaction(s). Check the log for failures.`,
        sigs.length === validRows.length ? "success" : "error"
      );
    } catch (e) {
      pushLog(`Unexpected error: ${e.message || e}`, "error");
      setPhase("error");
    }
  }

  // Lazy-load a Buffer polyfill and @solana/web3.js from CDN once, since
  // this artifact has no bundler and @solana/web3.js expects Node's Buffer
  // to exist as a global even in the browser.
  function loadScript(src, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timed out loading ${src}`)), timeoutMs);
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => {
        clearTimeout(t);
        resolve();
      };
      script.onerror = () => {
        clearTimeout(t);
        reject(new Error(`Failed to load ${src}`));
      };
      document.head.appendChild(script);
    });
  }

  async function importWeb3() {
    if (window.solanaWeb3) return window.solanaWeb3;

    if (!window.Buffer) {
      // Minimal Buffer polyfill — just enough of Node's Buffer API for
      // @solana/web3.js to work in the browser, without depending on a
      // CDN package whose export shape can vary.
      class MinimalBuffer extends Uint8Array {
        static from(data, encoding) {
          if (typeof data === "string") {
            if (encoding === "base64") {
              const bin = atob(data);
              const bytes = new MinimalBuffer(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              return bytes;
            }
            if (encoding === "hex") {
              const bytes = new MinimalBuffer(data.length / 2);
              for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(data.substr(i * 2, 2), 16);
              return bytes;
            }
            const enc = new TextEncoder().encode(data);
            return MinimalBuffer.from(enc);
          }
          const bytes = new MinimalBuffer(data.length || data.byteLength || 0);
          bytes.set(data instanceof Uint8Array ? data : new Uint8Array(data));
          return bytes;
        }
        static alloc(size) {
          return new MinimalBuffer(size);
        }
        static isBuffer(obj) {
          return obj instanceof MinimalBuffer;
        }
        static concat(list, totalLength) {
          const len = totalLength ?? list.reduce((a, b) => a + b.length, 0);
          const out = new MinimalBuffer(len);
          let offset = 0;
          for (const b of list) {
            out.set(b, offset);
            offset += b.length;
          }
          return out;
        }
        toString(encoding) {
          if (encoding === "base64") {
            let bin = "";
            for (let i = 0; i < this.length; i++) bin += String.fromCharCode(this[i]);
            return btoa(bin);
          }
          if (encoding === "hex") {
            return Array.from(this).map((b) => b.toString(16).padStart(2, "0")).join("");
          }
          return new TextDecoder().decode(this);
        }
      }
      window.Buffer = MinimalBuffer;
    }

    await loadScript("https://unpkg.com/@solana/web3.js@1.95.3/lib/index.iife.min.js");
    return window.solanaWeb3;
  }

  const isBusy = ["quoting", "building", "signing", "sending"].includes(phase);

  return (
    <div className="min-h-screen bg-[#0B0E11] text-[#E8EAED] font-sans">
      <div className="max-w-3xl mx-auto px-5 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-[#F5F6F7]">SOL Splitter</h1>
            <p className="text-sm text-[#8B92A0] mt-1">One SOL balance, split across up to 10 tokens via Jupiter.</p>
            <p className="text-[10px] text-[#4A5160] mt-1">Created by Samir</p>
          </div>
          {wallet ? (
            <button
              onClick={disconnectWallet}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#161A20] border border-[#262B33] text-sm hover:border-[#3A4150] transition-colors"
            >
              <span className="w-2 h-2 rounded-full bg-[#3ECF8E]" />
              {shortAddr(wallet.publicKey)}
            </button>
          ) : (
            <div className="flex gap-2">
              {availableProviders.length === 0 && (
                <span className="text-xs text-[#8B92A0] self-center">No wallet extension detected</span>
              )}
              {availableProviders.map((p) => (
                <button
                  key={p.key}
                  onClick={() => connectWallet(p)}
                  disabled={connecting}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#8B5CF6] text-white text-sm font-medium hover:bg-[#7C4FE0] transition-colors disabled:opacity-50"
                >
                  <Wallet size={15} />
                  {connecting ? "Connecting…" : `Connect ${p.label}`}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* SOL amount */}
        <div className="bg-[#12151A] border border-[#1E232B] rounded-xl p-5 mb-4">
          <label className="text-xs font-medium text-[#8B92A0] uppercase tracking-wide">Total SOL to split</label>
          <div className="mt-2 flex items-center gap-3">
            <input
              type="number"
              min="0"
              step="0.01"
              value={solAmount}
              onChange={(e) => setSolAmount(e.target.value)}
              className="flex-1 bg-[#0B0E11] border border-[#262B33] rounded-lg px-4 py-3 text-lg font-medium text-[#F5F6F7] focus:outline-none focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6]"
              placeholder="0.5"
            />
            <span className="text-[#8B92A0] font-medium">SOL</span>
          </div>
          <div className="mt-3 flex items-center gap-3 text-xs text-[#8B92A0]">
            <span>Slippage</span>
            {[50, 100, 300].map((bps) => (
              <button
                key={bps}
                onClick={() => setSlippageBps(bps)}
                className={`px-2.5 py-1 rounded-md border transition-colors ${
                  slippageBps === bps
                    ? "border-[#8B5CF6] text-[#C4B5FD] bg-[#8B5CF6]/10"
                    : "border-[#262B33] hover:border-[#3A4150]"
                }`}
              >
                {(bps / 100).toFixed(1)}%
              </button>
            ))}
          </div>

          <div className="mt-4 pt-4 border-t border-[#1E232B]">
            <label className="text-xs font-medium text-[#8B92A0] uppercase tracking-wide">
              Destination wallet <span className="normal-case text-[#4A5160]">(optional — leave blank to receive in your own wallet)</span>
            </label>
            <input
              value={destWallet}
              onChange={(e) => setDestWallet(e.target.value)}
              placeholder="Recipient's Solana wallet address"
              className="mt-2 w-full bg-[#0B0E11] border border-[#262B33] rounded-lg px-4 py-2.5 text-sm font-mono text-[#D5D8DD] focus:outline-none focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6]"
            />
            {destWallet.trim() && (
              <p className="mt-2 text-xs text-[#F5B942] flex items-center gap-1.5">
                <AlertTriangle size={12} />
                Swapped tokens will be sent to this address instead of your own wallet. If this wallet
                has never held a given token before, a small one-time account rent (~0.002 SOL per new
                token) is paid from your wallet. Double-check the address — sends are irreversible.
              </p>
            )}
          </div>
        </div>

        {/* Token rows */}
        <div className="bg-[#12151A] border border-[#1E232B] rounded-xl p-5 mb-4">
          <div className="flex items-center justify-between mb-3">
            <label className="text-xs font-medium text-[#8B92A0] uppercase tracking-wide">
              Target tokens ({rows.length}/10)
            </label>
            <div className="flex gap-2">
              <button
                onClick={distributeEvenly}
                className="text-xs px-2.5 py-1 rounded-md border border-[#262B33] text-[#8B92A0] hover:border-[#3A4150] hover:text-[#E8EAED] transition-colors"
              >
                Split evenly
              </button>
              <button
                onClick={addRow}
                disabled={rows.length >= 10}
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border border-[#262B33] text-[#8B92A0] hover:border-[#3A4150] hover:text-[#E8EAED] transition-colors disabled:opacity-40"
              >
                <Plus size={12} /> Add token
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {rows.map((row, i) => (
              <div key={row.id} className="flex items-center gap-2">
                <span className="text-xs text-[#4A5160] w-4 text-right shrink-0">{i + 1}</span>
                <input
                  value={row.mint}
                  onChange={(e) => updateRow(row.id, { mint: e.target.value, status: "idle", error: "" })}
                  placeholder="Token mint address"
                  className="flex-1 bg-[#0B0E11] border border-[#262B33] rounded-lg px-3 py-2 text-sm font-mono text-[#D5D8DD] focus:outline-none focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6]"
                />
                <div className="flex items-center shrink-0">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={row.weight}
                    onChange={(e) => updateRow(row.id, { weight: e.target.value })}
                    className="w-16 bg-[#0B0E11] border border-[#262B33] rounded-lg px-2 py-2 text-sm text-right text-[#D5D8DD] focus:outline-none focus:border-[#8B5CF6]"
                  />
                  <span className="text-xs text-[#8B92A0] ml-1">%</span>
                </div>
                <StatusIcon status={row.status} />
                <button
                  onClick={() => removeRow(row.id)}
                  className="text-[#4A5160] hover:text-[#F87171] transition-colors shrink-0"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>

          <div className={`mt-3 text-xs flex items-center gap-1.5 ${Math.abs(totalWeight - 100) > 0.5 ? "text-[#F87171]" : "text-[#3ECF8E]"}`}>
            {Math.abs(totalWeight - 100) > 0.5 && <AlertTriangle size={12} />}
            Total allocation: {totalWeight.toFixed(1)}%
          </div>
        </div>

        {/* Reality-check notice */}
        <div className="bg-[#1A1508] border border-[#3D2E0A] rounded-xl p-4 mb-4 text-xs text-[#D6B85C] leading-relaxed">
          This app tries to combine up to 5 token swaps into a single transaction, so the network fee is
          paid once per batch, not once per token. If a batch doesn't fit Solana's per-transaction size
          limit (this depends on how complex each token's swap route is), it automatically splits into
          smaller batches until it fits — so the swap still completes, just across a couple more
          transactions than the ideal case.
        </div>

        {/* Action */}
        <button
          onClick={runSwap}
          disabled={!wallet || isBusy || validRows.length === 0}
          className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl bg-[#8B5CF6] text-white font-medium hover:bg-[#7C4FE0] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isBusy ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
          {isBusy ? phaseLabel(phase) : `Swap ${solAmount || "0"} SOL into ${validRows.length} token${validRows.length === 1 ? "" : "s"}`}
        </button>

        {/* Log */}
        {log.length > 0 && (
          <div className="mt-5 bg-[#0E1116] border border-[#1E232B] rounded-xl p-4 max-h-64 overflow-y-auto">
            {log.map((l) => (
              <div key={l.id} className="text-xs font-mono flex gap-2 py-0.5">
                <span className="text-[#4A5160] shrink-0">{l.t}</span>
                <span
                  className={
                    l.kind === "error" ? "text-[#F87171]" : l.kind === "success" ? "text-[#3ECF8E]" : "text-[#8B92A0]"
                  }
                >
                  {l.msg}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Results */}
        {txSigs.length > 0 && (
          <div className="mt-4 bg-[#12151A] border border-[#1E232B] rounded-xl p-4">
            <label className="text-xs font-medium text-[#8B92A0] uppercase tracking-wide">Transactions</label>
            <div className="mt-2 space-y-1.5">
              {txSigs.map((s, i) => (
                <a
                  key={i}
                  href={`https://solscan.io/tx/${s.signature}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between text-xs font-mono text-[#8B92A0] hover:text-[#C4B5FD] transition-colors"
                >
                  <span>{shortAddr(s.mint)}</span>
                  <span className="flex items-center gap-1">
                    {shortAddr(s.signature)} <ExternalLink size={11} />
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        <p className="text-center text-[10px] text-[#4A5160] mt-8 leading-relaxed">
          Uses Jupiter's public swap API for routing. Always verify token mint addresses before swapping —
          this tool does not vet token legitimacy. You approve every transaction in your wallet.
        </p>
      </div>
    </div>
  );
}

function phaseLabel(phase) {
  switch (phase) {
    case "quoting":
      return "Fetching quotes…";
    case "building":
      return "Building transactions…";
    case "signing":
      return "Waiting for wallet approval…";
    case "sending":
      return "Sending…";
    default:
      return "Working…";
  }
}

function StatusIcon({ status }) {
  const common = "shrink-0";
  switch (status) {
    case "quoting":
    case "building":
    case "signing":
      return <Loader2 size={14} className={`${common} animate-spin text-[#8B92A0]`} />;
    case "quoted":
    case "built":
      return <div className={`${common} w-2 h-2 rounded-full bg-[#F5B942]`} title="Ready" />;
    case "done":
      return <CheckCircle2 size={14} className={`${common} text-[#3ECF8E]`} />;
    case "error":
      return <XCircle size={14} className={`${common} text-[#F87171]`} />;
    default:
      return <div className={`${common} w-2 h-2 rounded-full bg-[#2A303A]`} />;
  }
}
