FROM node:24.5.0-slim AS builder

RUN apt-get update && apt-get install -y python3 python3-pip sqlite3 && rm -rf /var/lib/apt/lists/*

WORKDIR /home/vane

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000

COPY tsconfig.json next.config.mjs next-env.d.ts postcss.config.js drizzle.config.ts tailwind.config.ts ./
COPY src ./src
COPY public ./public
COPY drizzle ./drizzle

RUN mkdir -p /home/vane/data
RUN yarn build

FROM node:24.5.0-slim

RUN apt-get update && apt-get install -y \
    python3-dev python3-babel python3-venv python-is-python3 \
    uwsgi uwsgi-plugin-python3 \
    git build-essential libxslt-dev zlib1g-dev libffi-dev libssl-dev \
    curl sudo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/vane

COPY --from=builder /home/vane/public ./public
COPY --from=builder /home/vane/.next/static ./public/_next/static
COPY --from=builder /home/vane/.next/standalone ./
COPY --from=builder /home/vane/data ./data
COPY drizzle ./drizzle

RUN mkdir /home/vane/uploads

# The standalone output ships the full package.json (with ^ ranges) but no
# lockfile, so `yarn add` below would re-resolve EVERY dependency to the newest
# matching version - while .next was compiled against the locked versions.
# That drift crashes the server at boot (Next 16.2.2 build vs 16.3.3 runtime:
# "Cannot read properties of undefined (reading 'validationLevel')").
# Copying the lockfile pins the tree to exactly what the build used.
COPY --from=builder /home/vane/yarn.lock ./yarn.lock

RUN yarn add playwright
RUN yarn playwright install --with-deps --only-shell chromium

RUN useradd --shell /bin/bash --system \
    --home-dir "/usr/local/searxng" \
    --comment 'Privacy-respecting metasearch engine' \
    searxng

# portal.stf.jus.br is not behind anti-bot: its server sends the leaf certificate
# twice and omits the GlobalSign intermediate, so no client can build the chain
# (curl error 60, Node UNABLE_TO_GET_ISSUER_CERT_LOCALLY). The intermediate is
# published at the AIA URL inside the STF certificate itself; adding it to the
# trust store completes the chain the server failed to send. Nothing is being
# bypassed - with it, portal.stf.jus.br verifies normally and answers 200.
COPY certs/gs-alphassl-r6-2025.crt /usr/local/share/ca-certificates/gs-alphassl-r6-2025.crt
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/gs-alphassl-r6-2025.crt

RUN mkdir "/usr/local/searxng"
RUN mkdir -p /etc/searxng
RUN chown -R "searxng:searxng" "/usr/local/searxng"

COPY searxng/settings.yml /etc/searxng/settings.yml
COPY searxng/limiter.toml /etc/searxng/limiter.toml
COPY searxng/uwsgi.ini /etc/searxng/uwsgi.ini
RUN chown -R searxng:searxng /etc/searxng

USER searxng

RUN git clone "https://github.com/searxng/searxng" \
                   "/usr/local/searxng/searxng-src"

RUN python3 -m venv "/usr/local/searxng/searx-pyenv"
RUN "/usr/local/searxng/searx-pyenv/bin/pip" install --upgrade pip setuptools wheel pyyaml msgspec typing_extensions
RUN cd "/usr/local/searxng/searxng-src" && \
    "/usr/local/searxng/searx-pyenv/bin/pip" install --use-pep517 --no-build-isolation -e .

USER root

# Custom SearXNG engines for Brazilian legal research. Both query the source's
# own search instead of a general web engine, which keeps them off the shared
# `google cse` quota (that engine runs on a hardcoded public CX and suspends
# itself after a handful of queries). They are declared `disabled: true` in
# settings.yml and activated per-request by name.
COPY searxng/engines/migalhas.py /usr/local/searxng/searxng-src/searx/engines/migalhas.py
COPY searxng/engines/conjur.py /usr/local/searxng/searxng-src/searx/engines/conjur.py
COPY searxng/engines/dizerodireito.py /usr/local/searxng/searxng-src/searx/engines/dizerodireito.py
COPY searxng/engines/stjrepetitivos.py /usr/local/searxng/searxng-src/searx/engines/stjrepetitivos.py
COPY searxng/engines/bnp.py /usr/local/searxng/searxng-src/searx/engines/bnp.py
COPY searxng/engines/cjf.py /usr/local/searxng/searxng-src/searx/engines/cjf.py
RUN chown searxng:searxng \
    /usr/local/searxng/searxng-src/searx/engines/migalhas.py \
    /usr/local/searxng/searxng-src/searx/engines/conjur.py \
    /usr/local/searxng/searxng-src/searx/engines/dizerodireito.py \
    /usr/local/searxng/searxng-src/searx/engines/stjrepetitivos.py \
    /usr/local/searxng/searxng-src/searx/engines/bnp.py \
    /usr/local/searxng/searxng-src/searx/engines/cjf.py

WORKDIR /home/vane
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
RUN sed -i 's/\r$//' ./entrypoint.sh || true

RUN echo "searxng ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

EXPOSE 3000 8080

ENV SEARXNG_API_URL=http://localhost:8080

CMD ["/home/vane/entrypoint.sh"]
