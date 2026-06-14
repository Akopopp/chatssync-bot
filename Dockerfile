FROM node:20-alpine

WORKDIR /app

# Pehle sirf package files copy karo (caching ke liye)
COPY package.json ./
RUN npm install --omit=dev

# Baaki code copy karo
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
