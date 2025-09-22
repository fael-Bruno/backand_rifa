import express from "express";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();
const app = express();
app.use(express.json());

const prisma = new PrismaClient();

app.get("/", (req, res) => {
  res.send("Backend rodando!");
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
