'use strict';

/**
 * 初始化示例数据：创建一个学期、若干课程、节假日与调休记录。
 * 用法：npm run seed    （重复执行会先清空再写入）
 */

const store = require('../src/store');
const { weekStartMonday, addDays, toDateStr, todayStr, uid } = require('../src/util');

function run() {
  const store2 = store.init();
  const today = new Date();
  const thisMonday = weekStartMonday(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
  const start = addDays(thisMonday, -28); // 从第 1 周开始，当前处于第 5 周左右

  store.replaceAll({ terms: [], courses: [], holidays: [] });

  const term = store.createTerm({
    name: '2026-2027学年 秋季学期',
    startDate: toDateStr(start),
    weeks: 20,
  });

  const P = {
    '1-2': [1, 2], '3-4': [3, 4], '5-6': [5, 6], '7-8': [7, 8], '9-10': [9, 10],
  };

  const courses = [
    { name: '高等数学A（上）', teacher: '张伟', location: '教三-301', dayOfWeek: 1, ...sp(P['1-2']), weeks: '1-16周', className: '计科2301', credit: 5, color: '#4F7CF7' },
    { name: '大学英语（三）', teacher: '李娜', location: '外语楼-202', dayOfWeek: 1, ...sp(P['5-6']), weeks: { mode: 'all' }, className: '计科2301', credit: 3, color: '#7C5CFF' },
    { name: '数据结构与算法', teacher: '王强', location: '实验楼-A405', dayOfWeek: 2, ...sp(P['3-4']), weeks: '1-16周', className: '计科2301', credit: 4, color: '#17B26A' },
    { name: '计算机组成原理', teacher: '刘洋', location: '教二-108', dayOfWeek: 2, ...sp(P['7-8']), weeks: '1-16周双', className: '计科2301', credit: 3, color: '#F79009' },
    { name: '概率论与数理统计', teacher: '陈静', location: '教三-208', dayOfWeek: 3, ...sp(P['1-2']), weeks: '1-12周', className: '计科2301', credit: 3, color: '#EE46BC' },
    { name: '马克思主义基本原理', teacher: '赵敏', location: '文科楼-101', dayOfWeek: 3, ...sp(P['5-6']), weeks: '1-16周单', className: '计科2301', credit: 3, color: '#DD2590' },
    { name: '计算机网络', teacher: '孙涛', location: '实验楼-B302', dayOfWeek: 4, ...sp(P['3-4']), weeks: '1-16周', className: '计科2301', credit: 3, color: '#0BA5EC' },
    { name: '数据库系统原理', teacher: '周雨', location: '教四-505', dayOfWeek: 4, ...sp(P['9-10']), weeks: '1-16周', className: '计科2301', credit: 3, color: '#F04438' },
    { name: 'Web前端开发实训', teacher: '吴磊', location: '机房-605', dayOfWeek: 5, ...sp(P['5-6']), weeks: '3-14周', className: '计科2301', credit: 2, color: '#12B76A' },
    { name: '体育（篮球）', teacher: '马超', location: '体育馆', dayOfWeek: 5, ...sp(P['7-8']), weeks: { mode: 'all' }, className: '计科2301', credit: 1, color: '#FF9C66' },
    { name: '数据结构实验', teacher: '王强', location: '实验楼-A405', dayOfWeek: 2, ...sp(P['9-10']), weeks: '3-14周双', className: '计科2301', credit: 1, color: '#84CAFF' },
  ];

  for (const c of courses) {
    store.bulkCreateCourses([{ ...c, termId: term.id }]);
  }

  // 节假日与调休：国庆 10/01-10/07，10/10（周六）按周五课表补
  const y = start.getUTCFullYear();
  const holidayDates = ['10-01', '10-02', '10-05', '10-06', '10-07'];
  for (const md of holidayDates) {
    store.createHoliday({ termId: term.id, date: `${y}-${md}`, type: 'holiday', name: '国庆节假期' });
  }
  store.createHoliday({
    termId: term.id, date: `${y}-10-10`, type: 'makeup', name: '国庆调休（按周五课表上课）', targetDayOfWeek: 5,
  });

  console.log('✅ 示例数据写入完成');
  console.log(`   学期  : ${term.name}（第一周周一 ${term.startDate}，共 ${term.weeks} 周）`);
  console.log(`   课程  : ${courses.length} 门`);
  console.log(`   今日  : ${todayStr()}`);
  console.log(`   订阅  : /ics/${term.subscriptionToken}.ics`);
  return { term, count: courses.length };
}

function sp([a, b]) {
  return { startPeriod: a, endPeriod: b };
}

if (require.main === module) run();
module.exports = { run };
