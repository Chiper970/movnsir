/*
 * Copyright (c) 2021 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { TrieCache } from "./trie-cache.js";
import { createTrie } from "@serverless-dns/trie/ftrie.js";
import { BlocklistFilter } from "./filter.js";
import { withDefaults } from "./trie-config.js";
import * as bufutil from "../../commons/bufutil.js";
import * as util from "../../commons/util.js";
import * as envutil from "../../commons/envutil.js";
import * as rdnsutil from "../rdns-util.js";

export class BlocklistWrapper {
  constructor() {
    this.blocklistFilter = new BlocklistFilter();
    this.startTime = Date.now(); // blocklist download timestamp
    this.isBlocklistUnderConstruction = false;
    this.exceptionFrom = "";
    this.exceptionStack = "";
    this.noop = envutil.disableBlocklists();

    this.log = log.withTags("BlocklistWrapper");

    if (this.noop) this.log.w("disabled?", this.noop);
  }

  async init(rxid) {
    if (this.isBlocklistFilterSetup() || this.disabled()) {
      const blres = util.emptyResponse();
      blres.data.blocklistFilter = this.blocklistFilter;
      return blres;
    }

    try {
      const now = Date.now();

      if (
        !this.isBlocklistUnderConstruction ||
        // it has been a while, queue another blocklist-construction
        now - this.startTime > envutil.downloadTimeout() * 2
      ) {
        this.log.i(rxid, "download blocklists", now, this.startTime);
        return this.initBlocklistConstruction(
          rxid,
          now,
          envutil.blocklistUrl(),
          envutil.timestamp(),
          envutil.tdNodeCount(),
          envutil.tdParts()
        );
      } else {
        // someone's constructing... wait till finished
        return this.waitUntilDone();
      }
    } catch (e) {
      this.log.e(rxid, "main", e.stack);
      return util.errResponse("blocklistWrapper", e);
    }
  }

  disabled() {
    return this.noop;
  }

  getBlocklistFilter() {
    return this.blocklistFilter;
  }

  isBlocklistFilterSetup() {
    return rdnsutil.isBlocklistFilterSetup(this.blocklistFilter);
  }

  async waitUntilDone() {
    // res.arrayBuffer() is the most expensive op, taking anywhere
    // between 700ms to 1.2s for trie. But: We don't want all incoming
    // reqs to wait until the trie becomes available. 400ms is 1/3rd of
    // 1.2s and 2x 250ms; both of these values have cost implications:
    // 250ms (0.28GB-sec or 218ms wall time) in unbound-worker per req
    // and equals cost of one bundled-worker req.
    let totalWaitms = 0;
    const waitms = 25;
    const response = util.emptyResponse();
    while (totalWaitms < envutil.downloadTimeout()) {
      if (this.isBlocklistFilterSetup()) {
        response.data.blocklistFilter = this.blocklistFilter;
        return response;
      }
      await util.sleep(waitms);
      totalWaitms += waitms;
    }

    response.isException = true;
    response.exceptionStack = this.exceptionStack || "download timeout";
    response.exceptionFrom = this.exceptionFrom || "blocklistWrapper.js";
    return response;
  }

  buildBlocklistFilter(td, rd, ftags, bconfig) {
    this.isBlocklistUnderConstruction = true;
    this.startTime = Date.now();
    // if optflags is undefined, then explicitly set it to be false
    bconfig = withDefaults(bconfig);
    const ftrie = this.makeTrie(td, rd, bconfig);
    this.blocklistFilter.load(ftrie, ftags);
    this.log.i("fs:trie w/ config", bconfig);
    this.isBlocklistUnderConstruction = false;
  }

  makeTrie(tdbuf, rdbuf, bconfig) {
    return createTrie(tdbuf, rdbuf, bconfig, new TrieCache());
  }

  async initBlocklistConstruction(
    rxid,
    when,
    blocklistUrl,
    latestTimestamp,
    tdNodecount,
    tdParts
  ) {
    this.isBlocklistUnderConstruction = true;
    this.startTime = when;

    let response = util.emptyResponse();
    try {
      await this.downloadAndBuildBlocklistFilter(
        rxid,
        blocklistUrl,
        latestTimestamp,
        tdNodecount,
        tdParts
      );

      this.log.i(rxid, "blocklist-filter setup");
      if (false) {
        // test
        const result = this.blocklistFilter.blockstamp("google.com");
        this.log.d(rxid, JSON.stringify(result));
      }

      response.data.blocklistFilter = this.blocklistFilter;
    } catch (e) {
      this.log.e(rxid, "initBlocklistConstruction", e.stack);
      response = util.errResponse("initBlocklistConstruction", e);
      this.exceptionFrom = response.exceptionFrom;
      this.exceptionStack = response.exceptionStack;
    }

    this.isBlocklistUnderConstruction = false;

    return response;
  }

  async downloadAndBuildBlocklistFilter(
    rxid,
    blocklistUrl,
    latestTimestamp,
    tdNodecount,
    tdParts
  ) {
    !tdNodecount && this.log.e(rxid, "tdNodecount zero or missing!");

    const baseurl = blocklistUrl + latestTimestamp;
    let bconfig = {
      nodecount: tdNodecount || -1,
      tdparts: tdParts || -1,
    };

    bconfig = withDefaults(bconfig);

    this.log.d(rxid, blocklistUrl, latestTimestamp, tdNodecount, tdParts);
    // filetag is fetched as application/octet-stream and so,
    // the response api complains it is unsafe to .json() it:
    // Called .text() on an HTTP body which does not appear to be
    // text. The body's Content-Type is "application/octet-stream".
    // The result will probably be corrupted. Consider checking the
    // Content-Type header before interpreting entities as text.
    const buf0 = fileFetch(baseurl + "/filetag.json", "json");
    const buf1 = makeTd(baseurl, bconfig.tdparts);
    const buf2 = fileFetch(baseurl + "/rd.txt", "buffer");

    const downloads = await Promise.all([buf0, buf1, buf2]);

    this.log.i(rxid, "d:trie w/ config", bconfig);

    const td = downloads[1];
    const rd = downloads[2];
    const ft = downloads[0];

    const ftrie = this.makeTrie(td, rd, bconfig);

    this.blocklistFilter.load(ftrie, ft);

    return;
  }

  triedata() {
    const blf = this.blocklistFilter;
    const ftrie = blf.ftrie;
    const rdir = ftrie.directory;
    const d = rdir.data;
    return bufutil.raw(d.bytes);
  }

  rankdata() {
    const blf = this.blocklistFilter;
    const ftrie = blf.ftrie;
    const rdir = ftrie.directory;
    const d = rdir.directory;
    return bufutil.raw(d.bytes);
  }

  filetag() {
    const blf = this.blocklistFilter;
    return blf.filetag;
  }
}

async function fileFetch(url, typ) {
  if (typ !== "buffer" && typ !== "json") {
    log.i("fetch fail", typ, url);
    throw new Error("Unknown conversion type at fileFetch");
  }

  let res = { ok: false };
  try {
    log.i("downloading", url, typ);
    res = await fetch(url, { cf: { cacheTtl: /* 2w */ 1209600 } });
  } catch (ex) {
    log.w("download failed", url, ex, ex.cause);
    throw ex;
  }

  if (!res.ok) {
    log.e("file-fetch err", url, res);
    throw new Error(JSON.stringify([url, res, "fileFetch fail"]));
  }

  if (typ === "buffer") {
    return await res.arrayBuffer();
  } else if (typ === "json") {
    return await res.json();
  }
}

// joins split td parts into one td
async function makeTd(baseurl, n) {
  log.i("makeTd from tdParts", n);

  if (n <= -1) {
    return fileFetch(baseurl + "/td.txt", "buffer");
  }

  const tdpromises = [];
  for (let i = 0; i <= n; i++) {
    // td00.txt, td01.txt, td02.txt, ... , td98.txt, td100.txt, ...
    const f =
      baseurl +
      "/td" +
      i.toLocaleString("en-US", {
        minimumIntegerDigits: 2,
        useGrouping: false,
      }) +
      ".txt";
    tdpromises.push(fileFetch(f, "buffer"));
  }
  const tds = await Promise.all(tdpromises);

  log.i("tds downloaded");

  return bufutil.concat(tds);
}
