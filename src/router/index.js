import { createRouter, createWebHistory } from 'vue-router'
import mainPage from '@/views/main.vue'
import testPage from '@/views/test.vue'

const routes = [
  { path: '/', name: 'mainPage', component: mainPage },
  { path: '/abc', name: 'testPage', component: testPage }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
