import React, { useEffect, useState, useMemo, useCallback } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import CalendarHeatmap from "react-calendar-heatmap";
import {
  faChevronLeft,
  faChevronRight,
} from "@fortawesome/free-solid-svg-icons";
import { Line, Bar } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Filler,
} from "chart.js";
import zoomPlugin from "chartjs-plugin-zoom";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Filler,
  zoomPlugin,
);

const StatsView = ({ birthDate }) => {
  const [stats, setStats] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [calendarYear, setCalendarYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(true);
  const [milestones, setMilestones] = useState(null);

  const handleChangeYear = useCallback((offset) => {
    setCalendarYear((prev) => prev + offset);
  }, []);

  useEffect(() => {
    const fetchStats = async () => {
      setLoading(true);
      try {
        const res = await window.electron.ipcRenderer.invoke("fetch-stats", {
          birthDate,
        });
        if (res.success) setStats(res);
      } catch (err) {
        console.error("Failed to fetch stats", err);
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, [birthDate]);

  useEffect(() => {
    const fetchMilestones = async () => {
      try {
        const res =
          await window.electron.ipcRenderer.invoke("fetch-milestones");
        if (res.success) setMilestones(res);
      } catch (err) {
        console.error("Failed to fetch milestones", err);
      }
    };
    fetchMilestones();
  }, []);

  // Derive calendar data and streaks from the lightweight allDays array
  const calendarData = useMemo(() => {
    if (!stats?.allDays) return [];
    return stats.allDays
      .filter((d) => d.day.startsWith(String(calendarYear)))
      .map((d) => ({ date: d.day, count: d.count }));
  }, [stats, calendarYear]);

  const longestStreaks = useMemo(() => {
    if (!stats?.allDays?.length) return [];
    const days = stats.allDays.map((d) => d.day); // already sorted ASC from SQL
    const streaks = [];
    let streakStart = days[0];
    let streakLength = 1;

    for (let i = 1; i < days.length; i++) {
      const diff = (new Date(days[i]) - new Date(days[i - 1])) / 86400000;
      if (diff === 1) {
        streakLength++;
      } else {
        streaks.push({
          start: streakStart,
          end: days[i - 1],
          length: streakLength,
        });
        streakStart = days[i];
        streakLength = 1;
      }
    }
    streaks.push({
      start: streakStart,
      end: days[days.length - 1],
      length: streakLength,
    });
    return streaks.sort((a, b) => b.length - a.length);
  }, [stats]);

  const calendarDate = useMemo(
    () => ({
      start: new Date(calendarYear, 0, 1).getTime(),
      end: new Date(calendarYear, 11, 31, 23, 59, 59, 999).getTime(),
    }),
    [calendarYear],
  );

  const calendarMinMax = useMemo(() => {
    if (!calendarData.length) return { min: 0, max: 0 };
    const counts = calendarData.map((v) => v.count);
    return { min: Math.min(...counts), max: Math.max(...counts) };
  }, [calendarData]);

  const formatBytes = (bytes) => {
    if (!bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / k ** i).toFixed(2)) + " " + sizes[i];
  };

  const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  const formatMilestoneDate = (dateStr) => {
    if (!dateStr) return "—";
    const d = new Date(dateStr.replace(" ", "T"));
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  const toChartData = (data, xKey, color = "#775ae4") => {
    const isNumeric = xKey === "year" || xKey === "age";

    return {
      labels: isNumeric ? undefined : data.map((d) => d[xKey]),
      datasets: [
        {
          data: isNumeric
            ? data.map((d) => ({ x: Number(d[xKey]), y: d.count }))
            : data.map((d) => d.count),
          borderColor: color,
          backgroundColor: color + "33",
          borderWidth: 2,
          pointRadius: 2,
          fill: true,
          tension: 0.3,
        },
      ],
    };
  };

  const getChartOptions = (xKey, data) => {
    const isNumeric = xKey === "year" || xKey === "age";

    // Calculate min/max for zoom limits
    let minLimit, maxLimit;
    if (isNumeric && data.length > 0) {
      const values = data.map((d) => Number(d[xKey]));
      minLimit = Math.min(...values);
      maxLimit = Math.max(...values);
    }

    return {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const item = items[0];

              if (xKey === "year" || xKey === "age") {
                return String(Math.round(item.parsed.x));
              }

              return item.label;
            },
          },
        },
        zoom: {
          limits: isNumeric
            ? {
                x: { min: minLimit, max: maxLimit },
              }
            : undefined,
          pan: {
            enabled: true,
            mode: "x",
          },
          zoom: {
            wheel: {
              enabled: true,
            },
            pinch: {
              enabled: true,
            },
            mode: "x",
          },
        },
      },
      scales: {
        x: isNumeric
          ? {
              type: "linear",
              locale: "en-US",
              min: minLimit,
              max: maxLimit,
              ticks: {
                font: { size: 11 },
                stepSize: 1,
                precision: 0,
                callback: (value) => Number(value).toFixed(0),
              },
            }
          : {
              ticks: { font: { size: 11 } },
            },
        y: {
          ticks: { font: { size: 11 } },
          beginAtZero: true,
        },
      },
    };
  };

  const prepChartData = (data, xKey) => {
    // Filter out "Unknown" entries
    let filtered = data.filter((d) => d[xKey] !== "Unknown" && d[xKey] !== "");

    // Sort appropriately based on key type
    if (xKey === "year" || xKey === "age") {
      // Numeric ascending sort
      filtered = filtered.sort((a, b) => Number(a[xKey]) - Number(b[xKey]));
    } else if (xKey === "month") {
      // Month format is "YYYY-MM", sort chronologically
      filtered = filtered.sort((a, b) => a[xKey].localeCompare(b[xKey]));
    }
    // For device/country (categorical), keep original order (likely sorted by count DESC)

    return filtered;
  };

  if (loading)
    return (
      <div className="stats-loading">
        <div className="loader"></div>
      </div>
    );
  if (!stats) return null;

  const renderTable = (title, data, key1, key2, key3 = null) => {
    const sortedData = [...data].sort((a, b) => {
      if (a[key1] === "Unknown") return 1;
      if (b[key1] === "Unknown") return -1;
      return 0;
    });
    return (
      <div className="stats-card-wrapper">
        <h3>{title}</h3>
        <div className="stats-card">
          <table>
            <thead>
              <tr>
                <th>{capitalize(key1)}</th>
                {key3 && <th>{capitalize(key3)}</th>}
                <th>{capitalize(key2)}</th>
              </tr>
            </thead>
          </table>

          <div className="stats-card-body">
            <table>
              <tbody>
                {sortedData.map((item, idx) => (
                  <tr
                    key={idx}
                    className={item[key1] === "Unknown" ? "unknown-row" : ""}
                  >
                    <td>{item[key1]}</td>
                    {key3 && <td>{item[key3]}</td>}
                    <td>{item[key2]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="stats-layout">
      <div className="tabs-sidebar">
        {[
          { id: "overview", label: "Overview" },
          { id: "calendar", label: "Calendar" },
          { id: "sources", label: "Sources" },
          { id: "charts", label: "Charts" },
          { id: "milestones", label: "Milestones" },
        ].map((tab) => (
          <div
            key={tab.id}
            className={`tab-item ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </div>
        ))}
      </div>

      <div className="tab-content">
        {activeTab === "overview" && (
          <>
            <div className="stats-summary">
              <div className="stats-summary-card">
                <h3>Total Files</h3>
                <p>{stats.totalFiles}</p>
              </div>
              <div className="stats-summary-card">
                <h3>Total Size</h3>
                <p>{formatBytes(stats.totalStorage)}</p>
              </div>
            </div>
            <div className="stats-grid">
              {renderTable(
                "Total Media Per Year",
                stats.perYear,
                "year",
                "count",
              )}
              {renderTable(
                "Total Media Per Month",
                stats.perMonth,
                "month",
                "count",
              )}
              {renderTable("Total Media Per Age", stats.perAge, "age", "count")}
              {renderTable(
                "Top 10 Days by Media Count",
                stats.topDays,
                "day",
                "count",
              )}
              {renderTable("By File Type", stats.byType, "type", "count")}
              {renderTable("By Device", stats.byDevice, "device", "count")}
              {renderTable("By Country", stats.byCountry, "country", "count")}
            </div>
          </>
        )}
        {activeTab === "calendar" && (
          <div className="calendar-layout">
            <div className="calendar-heatmap">
              <div className="calendar-header">
                <h3>Calendar Heatmap</h3>
                <div className="calendar-controls">
                  <button onClick={() => handleChangeYear(-1)}>
                    <FontAwesomeIcon icon={faChevronLeft} />
                  </button>
                  <span>{calendarYear}</span>
                  <button onClick={() => handleChangeYear(1)}>
                    <FontAwesomeIcon icon={faChevronRight} />
                  </button>
                </div>
              </div>
              <div>
                <CalendarHeatmap
                  startDate={calendarDate.start}
                  endDate={calendarDate.end}
                  values={calendarData}
                  showOutOfRangeDays={true}
                  titleForValue={(value) =>
                    value ? `${value.date} (${value.count})` : ""
                  }
                  classForValue={(value) => {
                    if (!value) return "color-empty";
                    const { min, max } = calendarMinMax;
                    const scale =
                      max === min
                        ? 4
                        : Math.ceil(((value.count - min) / (max - min)) * 4);
                    return `color-scale-${scale}`;
                  }}
                />
              </div>
            </div>
            <div className="calendar-streaks">
              {renderTable(
                "Longest Streaks",
                longestStreaks.slice(0, 20),
                "start",
                "length",
                "end",
              )}
            </div>
          </div>
        )}
        {activeTab === "sources" && (
          <div className="stats-grid-vertical">
            <div className="stats-card-wrapper">
              <h3>Devices</h3>
              <div className="stats-card">
                <table>
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>First Date</th>
                      <th>Last Date</th>
                      <th>Count</th>
                    </tr>
                  </thead>
                </table>

                <div className="stats-card-body">
                  <table>
                    <tbody>
                      {stats.devices.map((s, idx) => (
                        <tr key={idx}>
                          <td>{s.device}</td>
                          <td>{s.first}</td>
                          <td>{s.last}</td>
                          <td>{s.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="stats-card-wrapper">
              <h3>Sources</h3>
              <div className="stats-card">
                <table>
                  <thead>
                    <tr>
                      <th>Folder</th>
                      <th>First Date</th>
                      <th>Last Date</th>
                      <th>Count</th>
                    </tr>
                  </thead>
                </table>

                <div className="stats-card-body">
                  <table>
                    <tbody>
                      {stats.sources.map((s, idx) => (
                        <tr key={idx}>
                          <td>{s.folder}</td>
                          <td>{s.first}</td>
                          <td>{s.last}</td>
                          <td>{s.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
        {activeTab === "charts" && (
          <div className="charts-grid">
            {[
              {
                title: "Media Per Year",
                data: stats.perYear,
                xKey: "year",
                Chart: Line,
              },
              {
                title: "Media Per Month",
                data: stats.perMonth,
                xKey: "month",
                Chart: Line,
              },
              {
                title: "Media Per Age",
                data: stats.perAge,
                xKey: "age",
                Chart: Line,
              },
              {
                title: "By Device",
                data: stats.byDevice,
                xKey: "device",
                Chart: Bar,
              },
              {
                title: "By Country",
                data: stats.byCountry,
                xKey: "country",
                Chart: Bar,
              },
            ].map(({ title, data, xKey, Chart }) => {
              const preparedData = prepChartData(data, xKey);

              return (
                <div className="stats-card-wrapper" key={title}>
                  <div className="stats-card stats-card-chart">
                    <h3>{title}</h3>
                    <Chart
                      data={toChartData(preparedData, xKey)}
                      options={getChartOptions(xKey, preparedData)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {activeTab === "milestones" && (
          <div className="stats-card-wrapper">
            <h3>Milestones</h3>

            <div className="stats-card">
              <table>
                <thead>
                  <tr>
                    <th>Milestone</th>
                    <th>Date</th>
                  </tr>
                </thead>
              </table>

              <div className="stats-card-body">
                <table>
                  <tbody>
                    <tr className="group-header">
                      <th colSpan="2">Achieved</th>
                    </tr>

                    {milestones?.achieved?.map((m) => (
                      <tr key={`achieved-${m.milestone}`}>
                        <td>{m.milestone.toLocaleString()}</td>
                        <td>{formatMilestoneDate(m.date)}</td>
                      </tr>
                    ))}

                    <tr className="group-header">
                      <th colSpan="2">Upcoming</th>
                    </tr>

                    {milestones?.upcoming?.map((m) => (
                      <tr key={`upcoming-${m.milestone}`}>
                        <td>{m.milestone.toLocaleString()}</td>
                        <td>
                          {m.unavailable
                            ? "Prediction unavailable"
                            : `≈ ${formatMilestoneDate(m.predictedDate)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default StatsView;
