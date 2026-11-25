FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends g++ bash coreutils \
 && rm -rf /var/lib/apt/lists/*
# Biên dịch sẵn bits/stdc++.h một lần để mỗi lần chấm biên dịch nhanh hơn nhiều
RUN set -e; H=$(find /usr/include -name stdc++.h -path "*bits*" | head -1); \
    mkdir -p /pch/bits; cp "$H" /pch/bits/stdc++.h; \
    g++ -O2 -std=c++17 -x c++-header /pch/bits/stdc++.h -o /pch/bits/stdc++.h.gch; \
    chmod -R a+rX /pch
WORKDIR /app
COPY runner.js .
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "runner.js"]
