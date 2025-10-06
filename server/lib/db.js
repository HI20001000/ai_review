import mysql from "mysql2/promise";

const {
    MYSQL_HOST = "localhost",
    MYSQL_PORT = "3306",
    MYSQL_USER = "root",
    MYSQL_PASSWORD = "",
    MYSQL_DATABASE = "ai_platform",
    MYSQL_POOL_SIZE = "10"
} = process.env;

const pool = mysql.createPool({
    host: MYSQL_HOST,
    port: Number(MYSQL_PORT),
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: Number(MYSQL_POOL_SIZE) || 10,
    namedPlaceholders: true
});

export default pool;
