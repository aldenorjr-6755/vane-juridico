export const POST = async (req: Request) => {
  try {
    const body: {
      lat: number;
      lng: number;
      measureUnit: 'Imperial' | 'Metric';
    } = await req.json();

    if (!body.lat || !body.lng) {
      return Response.json(
        {
          message: 'Requisição inválida.',
        },
        { status: 400 },
      );
    }

    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${body.lat}&longitude=${body.lng}&current=weather_code,temperature_2m,is_day,relative_humidity_2m,wind_speed_10m&timezone=auto${
        body.measureUnit === 'Metric' ? '' : '&temperature_unit=fahrenheit'
      }${body.measureUnit === 'Metric' ? '' : '&wind_speed_unit=mph'}`,
    );

    const data = await res.json();

    if (data.error) {
      console.error(`Error fetching weather data: ${data.reason}`);
      return Response.json(
        {
          message: 'Ocorreu um erro.',
        },
        { status: 500 },
      );
    }

    const weather: {
      temperature: number;
      condition: string;
      humidity: number;
      windSpeed: number;
      icon: string;
      temperatureUnit: 'C' | 'F';
      windSpeedUnit: 'm/s' | 'mph';
    } = {
      temperature: data.current.temperature_2m,
      condition: '',
      humidity: data.current.relative_humidity_2m,
      windSpeed: data.current.wind_speed_10m,
      icon: '',
      temperatureUnit: body.measureUnit === 'Metric' ? 'C' : 'F',
      windSpeedUnit: body.measureUnit === 'Metric' ? 'm/s' : 'mph',
    };

    const code = data.current.weather_code;
    const isDay = data.current.is_day === 1;
    const dayOrNight = isDay ? 'day' : 'night';

    switch (code) {
      case 0:
        weather.icon = `clear-${dayOrNight}`;
        weather.condition = 'Céu limpo';
        break;

      case 1:
        weather.icon = `cloudy-1-${dayOrNight}`;
        weather.condition = 'Predominantemente limpo';
        break;
      case 2:
        weather.icon = `cloudy-1-${dayOrNight}`;
        weather.condition = 'Parcialmente nublado';
        break;
      case 3:
        weather.icon = `cloudy-1-${dayOrNight}`;
        weather.condition = 'Nublado';
        break;

      case 45:
        weather.icon = `fog-${dayOrNight}`;
        weather.condition = 'Nevoeiro';
        break;
      case 48:
        weather.icon = `fog-${dayOrNight}`;
        weather.condition = 'Nevoeiro';
        break;

      case 51:
        weather.icon = `rainy-1-${dayOrNight}`;
        weather.condition = 'Garoa fraca';
        break;
      case 53:
        weather.icon = `rainy-1-${dayOrNight}`;
        weather.condition = 'Garoa moderada';
        break;
      case 55:
        weather.icon = `rainy-1-${dayOrNight}`;
        weather.condition = 'Garoa forte';
        break;

      case 56:
        weather.icon = `frost-${dayOrNight}`;
        weather.condition = 'Garoa congelante fraca';
        break;
      case 57:
        weather.icon = `frost-${dayOrNight}`;
        weather.condition = 'Garoa congelante forte';
        break;

      case 61:
        weather.icon = `rainy-2-${dayOrNight}`;
        weather.condition = 'Chuva fraca';
        break;
      case 63:
        weather.icon = `rainy-2-${dayOrNight}`;
        weather.condition = 'Chuva moderada';
        break;
      case 65:
        weather.condition = 'Chuva forte';
        weather.icon = `rainy-2-${dayOrNight}`;
        break;

      case 66:
        weather.icon = 'rain-and-sleet-mix';
        weather.condition = 'Chuva congelante fraca';
        break;
      case 67:
        weather.condition = 'Chuva congelante forte';
        weather.icon = 'rain-and-sleet-mix';
        break;

      case 71:
        weather.icon = `snowy-2-${dayOrNight}`;
        weather.condition = 'Neve fraca';
        break;
      case 73:
        weather.icon = `snowy-2-${dayOrNight}`;
        weather.condition = 'Neve moderada';
        break;
      case 75:
        weather.condition = 'Neve forte';
        weather.icon = `snowy-2-${dayOrNight}`;
        break;

      case 77:
        weather.condition = 'Neve';
        weather.icon = `snowy-1-${dayOrNight}`;
        break;

      case 80:
        weather.icon = `rainy-3-${dayOrNight}`;
        weather.condition = 'Pancadas de chuva fracas';
        break;
      case 81:
        weather.icon = `rainy-3-${dayOrNight}`;
        weather.condition = 'Pancadas de chuva moderadas';
        break;
      case 82:
        weather.condition = 'Pancadas de chuva fortes';
        weather.icon = `rainy-3-${dayOrNight}`;
        break;

      case 85:
        weather.icon = `snowy-3-${dayOrNight}`;
        weather.condition = 'Pancadas de neve fracas';
        break;
      case 86:
        weather.icon = `snowy-3-${dayOrNight}`;
        weather.condition = 'Pancadas de neve moderadas';
        break;
      case 87:
        weather.condition = 'Pancadas de neve fortes';
        weather.icon = `snowy-3-${dayOrNight}`;
        break;

      case 95:
        weather.condition = 'Tempestade';
        weather.icon = `scattered-thunderstorms-${dayOrNight}`;
        break;

      case 96:
        weather.icon = 'severe-thunderstorm';
        weather.condition = 'Tempestade com granizo fraco';
        break;
      case 99:
        weather.condition = 'Tempestade com granizo forte';
        weather.icon = 'severe-thunderstorm';
        break;

      default:
        weather.icon = `clear-${dayOrNight}`;
        weather.condition = 'Céu limpo';
        break;
    }

    return Response.json(weather);
  } catch (err) {
    console.error('An error occurred while getting home widgets', err);
    return Response.json(
      {
        message: 'Ocorreu um erro.',
      },
      {
        status: 500,
      },
    );
  }
};
