import axios from "axios";
import dotenv from "dotenv";
dotenv.config()

const MY_TOKEN = process.env.MY_TOKEN
const BASE_URL = `https://api.telegram.org/bot${MY_TOKEN}`;

function getAxiosInstance() {
    return {
        get(method: string, params: Record<string, any>) {
            return axios.get(`/${method}`, {
                baseURL: BASE_URL,
                params,
            });
        },
        post(method: string, data: object) {
            return axios({
                method: "post",
                baseURL: BASE_URL,
                url: `/${method}`,
                data,
            });
        },
    };
}

const axiosInstance = getAxiosInstance()
export { axiosInstance };
